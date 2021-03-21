'use strict';

const redis = require("redis");
const EventEmitter = require("events").EventEmitter;

class AsyncApiQueue {
  /**
   * This class is to control the async api requests and responses from worker
   * 
   * Using Redis to save the shared variable which can work across multiple instances of Lambda
   * 
   * Status:
   * - pending (waiting for the api response)
   * - done (200 repsonse)
   * - JSON.stringified message (non 200 reponse)
   * 
   * Note: 
   * - EventEmitter may not work well at Lambda due to possible multiple instances.
   * - Not recommend to use event as logic decision at Lambda
   * 
   * @class
   */
  constructor() {}

  /**
   * Static method to initialize the class before use
   * 
   * @param {string} redisUrl Redis server URL
   * @param {string} [prefix] Prefix string of redis key
   * @param {number} [size=5] Size of the queue
   * @param {number} [expiration=86400] Expiration time on the redis cache
   */
  static async initialize(redisUrl, prefix = "", size = 5, expiration = 60 * 60 * 24) {
    AsyncApiQueue.size = size;
    AsyncApiQueue.expiration = expiration;
    AsyncApiQueue.client = redis.createClient({
      url: redisUrl,
      prefix: prefix
    });
    AsyncApiQueue.client.on("error", (error) => console.error(error));
    AsyncApiQueue.emitter = new EventEmitter();
    AsyncApiQueue.emitter
      .on("setDone", (id) => console.log(`Process ${id} is set done`))

    // if queue size and count were initialized already, skip the initialization
    //
    if (await AsyncApiQueue.getSize() != size) { await AsyncApiQueue.initializeRedis(); }
  }

  /**
   * Static method to close the redis client connection
   */
  static close() { AsyncApiQueue.client.quit(); }

  /**
   * Static method to initialize queue parameters
   * 
   * @returns {promise}
   */
  static async initializeRedis() { return Promise.resolve(await Promise.all([AsyncApiQueue.setCount(0), AsyncApiQueue.setSize(AsyncApiQueue.size)])); }

  /**
   * Static method to get the size of queue
   * 
   * @returns {promise} promise with number
   */
  static async getSize() {
    let size = await AsyncApiQueue.getRedis("QUEUE_SIZE");
    if (size === null) { await AsyncApiQueue.initializeRedis(); }
    return Promise.resolve(size === null ? AsyncApiQueue.size : size);
  }

  /**
   * Static method to get the item count at queue
   * 
   * @returns {promise} promise with number
   */
  static async getCount() {
    let size = await AsyncApiQueue.getRedis("QUEUE_COUNT");
    if (size === null) { await AsyncApiQueue.initializeRedis(); }
    return Promise.resolve(size === null ? 0 : size);
  }

  /**
   * Static method to set size of the queue
   * 
   * @param {number} value Queue size
   * @returns {promise}
   */
  static async setSize(value) { return Promise.resolve(await AsyncApiQueue.setRedis("QUEUE_SIZE", value)); }

  /**
   * Static method to set count of job at queue
   * 
   * @param {number} value Queue count
   * @returns {promise}
   */
  static async setCount(value) { return Promise.resolve(await AsyncApiQueue.setRedis("QUEUE_COUNT", value)); }
  
  /**
   * Static method to add one job count at queue
   * 
   * @returns {promise}
   */
  static async up1Count() {
    let count = await AsyncApiQueue.getCount();
    return Promise.resolve(await AsyncApiQueue.setCount(++count));
  }

  /**
   * Static method to down one to job count at queue
   * 
   * @returns {promise}
   */
  static async down1Count() {
    let count = await AsyncApiQueue.getCount();
    return Promise.resolve(await AsyncApiQueue.setCount(count > 0 ? --count : 0));
  }

  /**
   * Static method to check if queue is full
   * 
   * @returns {promise} Promise with boolean
   */
  static async isFullQueue() {
    let [count, size] = await Promise.all([AsyncApiQueue.getCount(), AsyncApiQueue.getSize()]);
    return Promise.resolve(count >= size);
  }

  /**
   * Static method to add job to queue
   * - addRequest() and setRequest() are needed to be used together
   * - addRequest is used before calling api, it is for check if queue is full and increase the queue count
   * - setRequest will be used to store the messageId return from the api call
   * 
   * @param {string} key Job id
   * @returns {promise}
   */
  static async setRequest(key) { return Promise.resolve(await AsyncApiQueue.setRedis(key, "pending")); }

  /**
   * Static method to request a new job to be added to queue
   * - addRequest() and setRequest() are needed to be used together
   * - addRequest is used before calling api, it is for check if queue is full and increase the queue count
   * - setRequest will be used to store the messageId return from the api call
   * 
   * @returns {promise}
   */
  static async addRequest() {
    if (await AsyncApiQueue.isFullQueue()) { return Promise.reject(`no-of-request-is-at-limit`); }
    return Promise.resolve(await AsyncApiQueue.up1Count()); 
  }

  /**
   * Static method to remove a job from queue
   * 
   * @param {string} id Job id
   * @returns {promise} Promise with number - 0 if no record fonund, or 1
   */
  static async removeRequest(id) {
    let result = 0, isDone = await AsyncApiQueue.checkDone(id);

    if (isDone !== null) {
      result = await AsyncApiQueue.delRedis(id);

      // if isDone, Count has been reduced by setDone()
      //
      if (result == 1 && !isDone) { await AsyncApiQueue.down1Count(); }
    }

    return Promise.resolve(result);
  }

  /**
   * Static method to set done at job
   * 
   * @param {string} id Job id
   * @param {string} response Redis value with the response message
   * @returns {promise}
   */
  static async setDone(id, response) {
    let result = await AsyncApiQueue.setRedis(id, response);
    AsyncApiQueue.emitter.emit("setDone", id);

    // Process won't count the limit after it is set done. But it is better to remove it if it is no longer needed
    //
    await AsyncApiQueue.down1Count();

    return Promise.resolve(result);
  }

  /**
   * Static method to check if the job is done
   * 
   * @param {string} id Job id
   * @returns {promise} Promise - null if no record is found, false when value is "pending" or value of matching job id
   */
  static async checkDone(id) {
    let result = await AsyncApiQueue.getRedis(id);
    return Promise.resolve(result === "pending" ? false : result);
  }
  

  ///////////////////////// Shared Redis operation functions below /////////////////////////////////////

  /**
   * Static method to set key/value to redis server
   * 
   * @param {string} key Redis key
   * @param {string} value Redis value
   * @returns {promise}
   */
  static async setRedis(key, value) {
    let error, result = new Promise((resolve, reject) => {
      AsyncApiQueue.client.set(key, value, "EX", AsyncApiQueue.expiration, (err, res) => {
        if (err) { reject(err); }
        else { resolve(res); }
      });
    });

    result = await result.catch(err => error = err);
    if (error) { return Promise.reject(error); }

    return Promise.resolve(result);
  }

  /**
   * Static method to get value from redis server
   * 
   * @param {string} key Redis key
   * @returns {promise} Promise with value
   */
  static async getRedis(key) {
    let error, result = new Promise((resolve, reject) => {
      AsyncApiQueue.client.get(key, (err, res) => {
        if (err) { reject(err); }
        else { resolve(res); }
      });
    });

    result = await result.catch(err => error = err);
    if (error) { return Promise.reject(error); }

    return Promise.resolve(result);
  }

  /**
   * Static method to delete the key value pair at redis server
   * 
   * @param {string} key Redis key
   * @returns {promise}
   */
  static async delRedis(key) {
    let error, result = new Promise((resolve, reject) => {
      AsyncApiQueue.client.del(key, (err, res) => {
        if (err) { reject(err); }
        else { resolve(res); }
      });
    });

    result = await result.catch(err => error = err);
    if (error) { return Promise.reject(error); }

    return Promise.resolve(result);
  }
}

module.exports = AsyncApiQueue;