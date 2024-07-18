import path from 'node:path';

import NorthConnector from '../north-connector';
import manifest from './manifest';
import { NorthConnectorDTO } from '../../../../shared/model/north-connector.model';
import EncryptionService from '../../service/encryption.service';
import RepositoryService from '../../service/repository.service';
import pino from 'pino';
import { DateTime } from 'luxon';
import { NorthSFTPSettings } from '../../../../shared/model/north-settings.model';
import csv from 'papaparse';
import { OIBusDataValue } from '../../../../shared/model/engine.model';

import sftpClient, { ConnectOptions } from 'ssh2-sftp-client';
import fs from 'node:fs/promises';

/**
 * Class NorthSFTP - Write files in an output folder
 */
export default class NorthSFTP extends NorthConnector<NorthSFTPSettings> {
  static type = manifest.id;

  constructor(
    configuration: NorthConnectorDTO<NorthSFTPSettings>,
    encryptionService: EncryptionService,
    repositoryService: RepositoryService,
    logger: pino.Logger,
    baseFolder: string
  ) {
    super(configuration, encryptionService, repositoryService, logger, baseFolder);
  }

  async handleValues(values: Array<OIBusDataValue>): Promise<void> {
    const nowDate = DateTime.now().toUTC();
    const prefix = (this.connector.settings.prefix || '')
      .replace('@CurrentDate', nowDate.toFormat('yyyy_MM_dd_HH_mm_ss_SSS'))
      .replace('@ConnectorName', this.connector.name);
    const suffix = (this.connector.settings.suffix || '')
      .replace('@CurrentDate', nowDate.toFormat('yyyy_MM_dd_HH_mm_ss_SSS'))
      .replace('@ConnectorName', this.connector.name);

    const filename = `${prefix}${nowDate.toMillis()}${suffix}.csv`;

    const csvContent = csv.unparse(
      values.map(value => ({
        pointId: value.pointId,
        timestamp: value.timestamp,
        value: value.data.value
      })),
      {
        header: true,
        delimiter: ';'
      }
    );

    const target = `${this.connector.settings.remoteFolder}/${filename}`;
    await this.sendToSftpServer(Buffer.from(csvContent, 'utf8'), target);
    this.logger.debug(`File "${filename}" sent into "${target}" remote folder`);
  }

  async handleFile(filePath: string): Promise<void> {
    const nowDate = DateTime.now().toUTC().toFormat('yyyy_MM_dd_HH_mm_ss_SSS');

    // Remove timestamp from the file path
    const { name, ext } = path.parse(filePath);
    const filename = name.slice(0, name.lastIndexOf('-'));

    const prefix = (this.connector.settings.prefix || '').replace('@CurrentDate', nowDate).replace('@ConnectorName', this.connector.name);
    const suffix = (this.connector.settings.suffix || '').replace('@CurrentDate', nowDate).replace('@ConnectorName', this.connector.name);

    const resultingFilename = `${prefix}${filename}${suffix}${ext}`;
    const target = `${this.connector.settings.remoteFolder}/${resultingFilename}`;
    await this.sendToSftpServer(filePath, target);
    this.logger.debug(`File "${filePath}" sent into "${target}" remote folder`);
  }

  async sendToSftpServer(file: string | Buffer, target: string): Promise<void> {
    const connectionOptions = await this.createConnectionOptions();

    const client = new sftpClient();
    await client.connect(connectionOptions);
    await client.put(file, target);
    await client.end();
  }

  override async testConnection(): Promise<void> {
    let folderExists: false | 'd' | '-' | 'l' = false;
    const connectionOptions = await this.createConnectionOptions();
    try {
      const client = new sftpClient();
      await client.connect(connectionOptions);
      folderExists = await client.exists(this.connector.settings.remoteFolder);
      await client.end();
    } catch (error: any) {
      throw new Error(
        `Access error on "${this.connector.settings.remoteFolder}" on "${this.connector.settings.host}:${this.connector.settings.port}": ${error.message}`
      );
    }

    if (!folderExists) {
      throw new Error(
        `Remote target "${this.connector.settings.remoteFolder}" does not exist or the user does not have the right permissions`
      );
    } else if (folderExists !== 'd') {
      throw new Error(`Remote target "${this.connector.settings.remoteFolder}" is not a folder`);
    }
  }

  private async createConnectionOptions(): Promise<ConnectOptions> {
    switch (this.connector.settings.authentication) {
      case 'private-key':
        return {
          host: this.connector.settings.host,
          port: this.connector.settings.port,
          username: this.connector.settings.username || '',
          privateKey: await fs.readFile(this.connector.settings.privateKey!, 'utf8'),
          passphrase: this.connector.settings.passphrase ? await this.encryptionService.decryptText(this.connector.settings.passphrase) : ''
        };
      case 'password':
      default:
        return {
          host: this.connector.settings.host,
          port: this.connector.settings.port,
          username: this.connector.settings.username || '',
          password: this.connector.settings.password ? await this.encryptionService.decryptText(this.connector.settings.password) : ''
        };
    }
  }
}
