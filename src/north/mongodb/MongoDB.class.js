/* istanbul ignore file */

const mongo = require('mongodb')
const { vsprintf } = require('sprintf-js')

const ApiHandler = require('../ApiHandler.class')

/**
 * function return the content of value, that could be a Json object with path keys given by string value
 * without using eval function
 * @param {*} value - simple value (integer or float or string, ...) or Json object
 * @param {*} pathValue - The string path of value we want to retrieve in the Json Object
 * @return {*} The content of value depending on value type (object or simple value)
 */
const getJsonValueByStringPath = (value, pathValue) => {
  let tmpValue = value

  if (typeof value === 'object') {
    if (pathValue !== '') {
      const arrValue = pathValue.split('.')
      arrValue.forEach((k) => { tmpValue = tmpValue[k] })
    }
  }
  return tmpValue
}

/**
 * Class MongoDB - generates and sends MongoDB requests
 */
class MongoDB extends ApiHandler {
  static category = 'DatabaseIn'

  /**
   * Constructor for MongoDB
   * @constructor
   * @param {Object} applicationParameters - The application parameters
   * @param {Engine} engine - The Engine
   * @return {void}
   */
  constructor(applicationParameters, engine) {
    super(applicationParameters, engine)
    const {
      host,
      user,
      password,
      db,
      regExp,
      collection,
      indexFields,
      createCollection,
      createCollectionIndex,
      addTimestampToIndex,
      timeStampKey,
      useDataKeyValue,
      keyParentValue,
    } = this.application.MongoDB
    this.host = host
    this.user = user
    this.password = password
    this.database = db
    this.regExp = regExp
    this.collection = collection
    this.indexFields = indexFields
    this.createCollection = createCollection
    this.createCollectionIndex = createCollectionIndex
    this.addTimestampToIndex = addTimestampToIndex
    this.timestampKey = timeStampKey
    this.useDataKeyValue = useDataKeyValue
    this.keyParentValue = keyParentValue

    this.canHandleValues = true
  }

  /**
   * Handle values by sending them to MongoDB.
   * @param {object[]} values - The values
   * @return {Promise} - The handle status
   */
  async handleValues(values) {
    this.logger.silly(`MongoDB handleValues() call with ${values.length} values`)
    try {
      await this.makeRequest(values)
      this.statusData['Last handled values at'] = new Date().toISOString()
      this.statusData['Number of values sent since OIBus has started'] += values.length
      this.statusData['Last added point id (value)'] = `${values[values.length - 1].pointId} (${JSON.stringify(values[values.length - 1].data)})`
      this.updateStatusDataStream()
    } catch (error) {
      this.logger.error(error)
      throw ApiHandler.STATUS.COMMUNICATION_ERROR
    }
    return values.length
  }

  /**
   * Connection to MongoDB
   * @return {void}
   */
  connect() {
    super.connect()
    this.logger.info(`Connection to MongoDB: ${this.user === '' ? `mongodb://${this.host}` : `mongodb://${this.user}:<password>@${this.host}`} `)
    const url = (this.user === '') ? `mongodb://${this.host}`
      : `mongodb://${this.user}:${this.encryptionService.decryptText(this.password)}@${this.host}`

    this.client = new mongo.MongoClient(url, { useUnifiedTopology: true })
    this.client.connect((error) => {
      if (error) {
        this.logger.error(`Error during connection To MongoDB : ${error}`)
        this.clientDB = null
      } else {
        this.logger.info('Connection To MongoDB : OK')
        this.statusData['Connected at'] = new Date().toISOString()
        this.updateStatusDataStream()
        // open database db
        this.mongoClient = this.client.db(this.database)

        // TODO: check here
        // variables used to work with Collection and indexes creation if DB Collection doesn't exist
        // getting database list Collections
        this.listCollections = []
        this.mongoClient.listCollections({ nameonly: true }).toArray((err, collectionNames) => {
          if (!err) {
            this.listCollections = collectionNames.slice()
          }
        })

        // indication that collection existence is not checked
        this.collectionChecked = false
      }
    })
  }

  /**
   * Disconnection from MongoDB
   * @return {void}
   */
  disconnect() {
    this.logger.info('Disconnection from MongoDB')
    if (this.client) {
      this.client.close()
    }
    super.disconnect()
    this.statusData['Connected at'] = 'Not connected'
    this.updateStatusDataStream()
  }

  // TODO: check here
  /**
   * Makes an MongoDB request with the parameters in the Object arg.
   * @param {Object[]} entries - The entry from the event
   * @return {Promise} - The request status
   */
  async makeRequest(entries) {
    let body = ''
    let collectionValue = ''
    let indexFieldsValue = ''

    entries.forEach((entry) => {
      const { pointId, data } = entry

      const mainRegExp = new RegExp(this.regExp)
      const groups = mainRegExp.exec(pointId)
      // Remove the first element, which is the matched string, because we only need the groups
      groups.shift()

      collectionValue = vsprintf(this.collection, groups)
      indexFieldsValue = vsprintf(this.indexFields, groups)

      // If there are less groups than placeholders, vsprintf will put undefined.
      // We look for the number of 'undefined' before and after the replace to see if this is the case
      if ((collectionValue.match(/undefined/g) || []).length > (this.collection.match(/undefined/g) || []).length) {
        this.logger.error(`RegExp returned by ${this.regExp} for ${pointId} doesn't have enough groups for collection`)
        return
      }
      if ((indexFieldsValue.match(/undefined/g) || []).length > (this.indexFields.match(/undefined/g) || []).length) {
        this.logger.error(`RegExp returned by ${this.regExp} for ${pointId} doesn't have enough groups for indexes`)
        return
      }

      // convert indexFieldsValue into mongoIndexFields for inserting by insertMany function
      // example : "Site:XXX,Tranche:1,Repere:XXXXXXXXX"
      const mongoIndexFields = `"${indexFieldsValue}"`.replace(/:/g, '":"').replace(/,/g, '","')

      // Converts data into fields for inserting by insertMany function
      let mongoFields = null

      // As some usecases can produce value structured as Json Object, code is modified to process value which could be
      // simple value (integer, float, ...) or Json object
      let dataValue = null

      // Determinate the value to process depending on useDataKeyValue and keyParentValue parameters
      if (this.useDataKeyValue) {
        // data to use is value key of Json object data (data.value)
        // this data.value could be a Json object or simple value (i.e. integer or float or string, ...)
        // If it's a json, the function return data where path is given by keyParentValue parameter
        // even if json object containing more than one level of object.
        // for example : data : {value: {"level1":{"level2":{value:..., timestamp:...}}}}
        // in this context :
        //   - the object to use, containing value and timestamp, is localised in data.value object by keyParentValue string : level1.level2
        //   - To retrieve this object, we use getJsonValueByStringPath with parameters : (data.value, 'level1.level2')
        dataValue = getJsonValueByStringPath(data.value, this.keyParentValue)
      } else {
        // data to use is Json object data
        dataValue = data
      }

      Object.entries(dataValue).forEach(([fieldKey, fieldValue]) => {
        if (typeof fieldValue === 'string') {
          if (!mongoFields) mongoFields = `"${fieldKey}":"${fieldValue}"`
          else mongoFields = `${mongoFields},"${fieldKey}":"${fieldValue}"`
        } else if (!mongoFields) mongoFields = `"${fieldKey}":${fieldValue}`
        else mongoFields = `${mongoFields},"${fieldKey}":${fieldValue}`
      })

      // Append entry to body
      // body += `${collection},${tags} ${fields} ${preciseTimestamp}\n`
      if (body === '') {
        body = `{${mongoIndexFields},${mongoFields}}`
      } else {
        body += `,\n{${mongoIndexFields},${mongoFields}}`
      }
    })

    if (!this.collectionChecked) {
      if (this.createCollection) {
        // before inserting data in MongoDB, ensuring, for the first time, that
        // collection exists with indexes which are based on tags indexFields
        await this.ensureCollectionExists(collectionValue, indexFieldsValue, this.createCollectionIndex, this.addTimestampToIndex, this.timestampKey)
      }
    } else {
      // converting body in JSON Array
      const bodyJson = JSON.parse(`[${body}]`)

      // Inserting JSON Array in MongoDB
      this.mongoClient.collection(collectionValue).insertMany(bodyJson)
    }
    return true
  }

  // TODO: check here
  /**
   * Ensure Collection exists and create it with indexes if not exists
   * @param {string}   collection  - The collection name
   * @param {string[]} indexFields - array of fields which compose the index
   * @param {boolean}  createCollectionIndex - indicate if we have to create index collection after collection creation when collection doesn't exist
   * @param {boolean}  addTimestampToIndex - indicate that we have to add timestamp field to index fields
   * @param {string}   timeStampKey - indicate the timestamp field name to add in index
   * @return {void}
   */
  async ensureCollectionExists(collection, indexFields, createCollectionIndex, addTimestampToIndex, timeStampKey) {
    const icollection = this.listCollections.findIndex((file) => file.name === collection)

    if (icollection < 0) {
      // the collection doesn't exists, we create it with indexes
      await this.mongoClient.createCollection(collection, ((error1) => {
        if (error1) {
          this.logger.error(`Error during Collection (${collection}) creation : ${error1}`)
        } else {
          this.logger.info(`Collection (${collection}) Creation : Success`)
          // the collection was created

          if (createCollectionIndex) {
            // now we will create indexes based on indexFields

            // 1rst step : retrieve list of index fields
            // Remember : indexFields is a string formatted like this : "site:%2$s,unit:%3$s,sensor:%4$s"
            const listIndexFields = []
            const arrayTmp = (addTimestampToIndex ? `${indexFields},${timeStampKey}:xx`.replace(/"/g, '').split(/[\s,:]+/)
              : `${indexFields}`.replace(/"/g, '').split(/[\s,:]+/))

            for (let i = 0; i < arrayTmp.length; i += 2) {
              listIndexFields.push(arrayTmp[i])
            }

            // 2nd step : create a Json object which contain list of index fields and order (0/1)
            let listIndex = null
            for (let i = 0; i < listIndexFields.length; i += 1) {
              if (!listIndex) listIndex = `"${listIndexFields[i]}":1`
              else listIndex = `${listIndex},"${listIndexFields[i]}":1`
            }
            this.mongoClient.collection(collection).createIndex(JSON.parse(`{${listIndex}}`), ((error2) => {
              if (error2) {
                this.logger.error(`Error during Collection (${collection}) Indexes Creation : ${error2}`)
              } else {
                this.logger.info(`Collection (${collection}) Indexes Creation : Success`)
              }
            }))
          }
        }
      }))
    }
    // disable this part of code for the next time
    this.collectionChecked = true
  }
}

module.exports = MongoDB
