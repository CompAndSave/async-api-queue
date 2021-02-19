# Queue management on async api calls for serverless setting via Redis
## Recommended usage flow:
* Add api call request to queue before making the api call to make sure it won't exceed the queue size. It can limit the number of async calls to be sent at the same time.
* Set / reserve queue slot after the api call. Queue slot status will be `pending`.
* After the async api call is done processing, set done at the queue slot.  The api response will be stored at Redis cache.
* After the response is consumed by the application, remove the request from the queue to free up the slot.

**Initiatization is required when app starts. Here is an example.**
```
AsyncApiQueue.initialize(
  process.env.REDIS_URL,
  process.env.REDIS_PREFIX,
  process.env.QUEUE_SIZE,
  process.env.REDIS_CACHE_EXPIRATION_IN_SECONDS
);
```

**Examples:**
```
// Add request
//
await AsyncApiQueue.addRequest().catch(err => error = err);

// Set request
//
await AsyncApiQueue.setRequest(messageId);

// Check if the request is done
//
await AsyncApiQueue.checkDone(messageId);

// Set done
//
await AsyncApiQueue.setDone(messageId, responseMessage);

// Remove request
//
await AsyncApiQueue.removeRequest(messageId);

```