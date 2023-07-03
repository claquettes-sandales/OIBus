import manifest from './manifest';
import SouthConnector from '../south-connector';
import DeferredPromise from '../../service/deferred-promise';
import { OibusItemDTO, SouthConnectorDTO } from '../../../../shared/model/south-connector.model';
import EncryptionService from '../../service/encryption.service';
import ProxyService from '../../service/proxy.service';
import RepositoryService from '../../service/repository.service';
import pino from 'pino';
import { Instant } from '../../../../shared/model/types';
import { DateTime } from 'luxon';
import { QueriesHistory, TestsConnection } from '../south-interface';
import { HandlesAgent } from './agent-handler-interface';
import Agent from './agent';
import SouthOPCHDATest from './south-opchda-test';

/**
 * Class SouthOPCHDA - Run a HDA agent to connect to an OPCHDA server.
 * This connector communicates with the Agent through a TCP connection thanks to the TCP server created on OIBus
 * and associated to this connector
 */
export default class SouthOPCHDA extends SouthConnector implements HandlesAgent, QueriesHistory, TestsConnection {
  static type = manifest.id;

  private agent: Agent;

  // Initialized at connection
  private connection$: DeferredPromise | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private historyRead$: DeferredPromise | null = null;
  private historyReadTimeout: NodeJS.Timeout | null = null;

  private itemsByGroups = new Map<
    string,
    {
      aggregate: string;
      resampling: string;
      scanMode: string;
      points: Array<{
        name: string;
        nodeId: string;
      }>;
    }
  >();

  constructor(
    configuration: SouthConnectorDTO,
    items: Array<OibusItemDTO>,
    engineAddValuesCallback: (southId: string, values: Array<any>) => Promise<void>,
    engineAddFileCallback: (southId: string, filePath: string) => Promise<void>,
    encryptionService: EncryptionService,
    proxyService: ProxyService,
    repositoryService: RepositoryService,
    logger: pino.Logger,
    baseFolder: string,
    streamMode: boolean
  ) {
    super(
      configuration,
      items,
      engineAddValuesCallback,
      engineAddFileCallback,
      encryptionService,
      proxyService,
      repositoryService,
      logger,
      baseFolder,
      streamMode
    );

    this.agent = new Agent(this, configuration.settings, logger);
  }

  async connect(): Promise<void> {
    if (process.platform !== 'win32') {
      this.logger.error(`OIBus OPCHDA Agent only supported on Windows: ${process.platform}`);
      return;
    }

    this.connection$ = new DeferredPromise();
    await this.agent.connect();
    await this.connection$?.promise;
    await super.connect();
  }

  static async testConnection(settings: SouthConnectorDTO['settings'], logger: pino.Logger): Promise<void> {
    logger.trace(`Testing if OPCHDA connection settings are correct`);

    const opchdaTest = new SouthOPCHDATest(settings, logger);
    try {
      await opchdaTest.testConnection();
    } catch (error) {
      throw new Error(`Unable to connect to OPCHDA server: ${error}`);
    }

    logger.info(`OPCHDA connection settings are correct`);
  }

  /**
   * Get entries from the database between startTime and endTime (if used in the SQL query)
   * and write them into the cache and send it to the engine.
   */
  async historyQuery(items: Array<OibusItemDTO>, startTime: Instant, endTime: Instant): Promise<Instant> {
    this.historyRead$ = new DeferredPromise();

    let maxTimestamp = DateTime.fromISO(startTime).toMillis();

    for (const groupName of this.itemsByGroups.keys()) {
      this.logger.trace(`Reading ${groupName} group item in HDA Agent`);
      await this.agent.sendReadMessage(groupName, startTime, endTime);
    }

    this.historyReadTimeout = setTimeout(() => {
      this.historyRead$?.reject(
        new Error(`History query has not succeeded in the requested readTimeout: ${this.configuration.settings.readTimeout}s`)
      );
    }, this.configuration.settings.readTimeout * 1000);
    const retrievedTimestamp = await this.historyRead$.promise;
    maxTimestamp = retrievedTimestamp > maxTimestamp ? retrievedTimestamp : maxTimestamp;

    clearTimeout(this.historyReadTimeout);
    this.historyReadTimeout = null;
    return DateTime.fromMillis(maxTimestamp).toUTC().toISO() as Instant;
  }

  /**
   * Close the connection and reinitialize the connector.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.historyReadTimeout) {
      clearTimeout(this.historyReadTimeout);
    }

    await this.agent.disconnect();
    await super.disconnect();
  }

  async handleConnectMessage(connected: boolean, error: string): Promise<void> {
    if (!connected) {
      this.logger.error(
        `Unable to connect to "${this.configuration.settings.serverName}" on ${this.configuration.settings.host}: ${error}, retrying in ${this.configuration.settings.retryInterval}ms`
      );

      await this.agent.disconnect();
      this.reconnectTimeout = setTimeout(this.connect.bind(this), this.configuration.settings.retryInterval);

      return;
    }

    // Now that the HDA Agent is connected, the Agent can be initialized with the scan groups
    try {
      this.itemsByGroups = new Map<
        string,
        {
          aggregate: string;
          resampling: string;
          scanMode: string;
          points: Array<{
            name: string;
            nodeId: string;
          }>;
        }
      >();
      for (const [scanModeId, items] of this.itemsByScanModeIds.entries()) {
        for (const item of items.values()) {
          const groupName = `${scanModeId}-${item.settings.aggregate}-${item.settings.resampling}`;
          if (!this.itemsByGroups.get(groupName)) {
            this.itemsByGroups.set(groupName, {
              aggregate: item.settings.aggregate,
              resampling: item.settings.resampling,
              scanMode: item.scanModeId!,
              points: [{ name: item.name, nodeId: item.settings.nodeId }]
            });
          } else {
            const group = this.itemsByGroups.get(groupName)!;
            this.itemsByGroups.set(groupName, {
              aggregate: item.settings.aggregate,
              resampling: item.settings.resampling,
              scanMode: item.scanModeId!,
              points: [...group.points, { name: item.name, nodeId: item.settings.nodeId }]
            });
          }
        }
      }

      const groups = Array.from(this.itemsByGroups || new Map(), ([groupName, item]) => ({
        name: groupName,
        ...item
      }));

      await this.agent.sendInitializeMessage(groups, this.configuration.history.maxReadInterval, this.configuration.history.readDelay);
    } catch (error) {
      this.logger.error('The message has not been sent. Reinitializing the HDA agent.');

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }

      await this.disconnect();
      this.reconnectTimeout = setTimeout(this.connect.bind(this), this.configuration.settings.retryInterval);
    }
  }

  async handleInitializeMessage(): Promise<void> {
    this.connection$?.resolve();
  }

  async handleReadMessage(messageObject: any): Promise<void> {
    if (messageObject.Content.Error) {
      if (messageObject.Content.Disconnected) {
        this.logger.error('Agent disconnected from OPC HDA server');
        await this.disconnect();
        this.reconnectTimeout = setTimeout(this.agent.sendConnectMessage, this.configuration.settings.retryInterval);
      }
      this.historyRead$?.reject(new Error(messageObject.Content.Error));
      return;
    }

    if (messageObject.Content.Points === undefined) {
      this.historyRead$?.reject(new Error(`Missing points entry in response for group "${messageObject.Content.Group}"`));
      return;
    }

    if (messageObject.Content.Points.length === 0) {
      this.logger.debug(`Empty points response for group "${messageObject.Content.Group}"`);
      this.historyRead$?.resolve(0);
      return;
    }

    this.logger.trace(`Received ${messageObject.Content.Points.length} values for group "${messageObject.Content.Group}"`);

    const associatedGroup = this.itemsByGroups.get(messageObject.Content.Group);

    if (!associatedGroup) {
      this.historyRead$?.reject(new Error(`Group "${messageObject.Content.Group}" not found`));
      return;
    }

    let maxTimestamp = 0;
    const values = messageObject.Content.Points.filter((point: any) => {
      if (point.Timestamp !== undefined && point.Value !== undefined) {
        return true;
      }
      this.logger.error(`Point: "${point.ItemId}" is invalid: ${JSON.stringify(point)}`);
      return false;
    }).map((point: any) => {
      const associatedPointId = associatedGroup.points.find(scanGroupPoint => scanGroupPoint.nodeId === point.ItemId)?.name || point.ItemId;
      maxTimestamp =
        DateTime.fromISO(point.Timestamp).toMillis() > maxTimestamp ? DateTime.fromISO(point.Timestamp).toMillis() : maxTimestamp;

      return {
        pointId: associatedPointId,
        timestamp: DateTime.fromISO(point.Timestamp).toUTC().toISO(),
        data: { value: point.Value.toString(), quality: JSON.stringify(point.Quality) }
      };
    });
    await this.addValues(values);

    this.historyRead$?.resolve(maxTimestamp + 1);
  }
}
