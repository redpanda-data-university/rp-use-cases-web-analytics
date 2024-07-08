# Chapter 3 - Advanced Features
In Chapter 3 of the Redpanda Web Analytics course, we explore the following topics:

- Making data ingestion async
- Configure Redpanda to accept larger payloads
- Storing session recordings in Redpanda and Clickhouse
- Building a session replay feature using rrweb


## Async ingestion
One of the benefits of running our analytics service on _the edge_ is that our code for _collecting information_ is deployed very close to the end user. So we can initiate data collection very quickly after a user visits our website.

However, depending on where your Redpanda cluster is deployed, the cluster itself may not be geographically close to the user. So _producing the data_ may incur a few hundred milliseconds of additional latency.

Since the current implementation of our `track/` handler won't return a response until after the data is produced to Redpanda, let's make a slight modification to ingest the data into Redpanda asynchronously, and to return a response as soon as the data is collected.

To accomplish this, we can use a utility called `waitUntil` method to execute work asynchronously. To achieve this, we first need to break out the logic for producing data to Redpanda into a separate function inside of `index.ts`:

```js
async function produceToRedpanda(data: Record<string, any>, topic: string): Promise<void> {
  const body = JSON.stringify({
    "records": [
      {
        "value": data,
        "partition": 0
      }
    ]
  })

  const redpandaUrl = `http://localhost:8082/topics/${topic}`;

  await fetch(redpandaUrl, {
    method: "POST",
    headers: {
      "Content-Type": 'application/vnd.kafka.json.v2+json'
    },
    body: body,
  });
}
```

Finally, add the following line to the `/track` handler:

```js
c.executionCtx.waitUntil(produceToRedpanda(data, 'website_visits'))
```

The full implementation is shown below:

```js
async function produceToRedpanda(data: Record<string, any>, topic: string): Promise<void> {
 // ...
}

app.post('/track', async (c) => {
  // parse the payload that contains the page URL
  const { url } = await c.req.json()

  // parse the user agent
  const userAgent = c.req.header('user-agent')
  
  const parser = new UAParser(userAgent); // you need to pass the user-agent for nodejs
  const client: Record<string, any> = flattenObject(parser.getResult() as IResult);

  // add the client's IP address and country of origin
  // note: you may need to adjust this for different runtimes (Deno, Bun, etc)
  const ip = c.req.header("CF-Connecting-IP") || '127.0.0.1'
  const country = c.req.raw?.cf?.country
  
  // throw a timestamp in there too
  const timestamp = Math.floor(new Date().getTime() / 1000)

  // combine with the IP address, country
  const data = { url, ip, country, ...client, timestamp }

  // produce data to Redpanda asynchronously
  c.executionCtx.waitUntil(produceToRedpanda(data, 'website_visits'))

  // acknowledge that we tracked this event immediately
  return c.text("Ok")
});
```

Your code is now set up to acknowledge events as soon as we collect the data and to produce the events to Redpanda asynchronously.

## Session recording
One of the most advanced features that many third-party vendors offer is session recording. Unfortunately, it's also a feature that comes with a lot of data privacy concerns.

The idea is that whenever a user visits your website, everything they do, from mouse movements, clicks, to keystrokes, is recorded so that it can be replayed by an admin. This data can support many powerful use cases, including customer support, fraud / security investigations, and fine-grained product research.

To accomplish this, the _session recorder_ needs to watch every movement of your user, and also deconstruct the layout, style, and information in your webpage so that it can replay these user events in a visually meaningful way. If you're hesitant to ship such detailed information about your user behaviors and your platform to a third party, we're going to show you how to implement this advanced feature yourself.

### Setup
To get started, you'll need to create a new Redpanda topic for storing the session recordings.

One thing to note about session recordings is that in addition to the raw user events (e.g. clicks / mouse movements), the session recorder will also send metadata about the page itself (layout, style, etc) at the beginning of the recording, and these payloads can exceed Redpanda's default max message size of 1MB.

To accomodate this, we'll create a topic with a larger max message size (5MB), by running the following command:

```sh
rpk topic create session_recordings -c max.message.bytes=5242880
```

Next, create the destination table in Clickhouse by running the following DDL statement from your local [Clickhouse UI](http://localhost:8123/play).

```sql
CREATE OR REPLACE TABLE analytics.recordings_kafka (
    id String,
    page_title String,
    recording String,
    timestamp DateTime64(3)
) ENGINE = Kafka SETTINGS
    kafka_broker_list = 'redpanda-1:9092',
    kafka_topic_list = 'session_recordings',
    kafka_group_name = 'rp',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1;
```

As you can see, the `analytics.recordings_kafka` table uses the Kafka engine to read session recordings from a Redpanda topic called `session_recordings`.

Finally, create a materlized view that we can use to query the session recording data.

```sql
CREATE MATERIALIZED VIEW analytics.recordings
ENGINE = Memory
AS
SELECT
    id,
    page_title,
    recording,
    timestamp
FROM analytics.recordings_kafka
SETTINGS
stream_like_engine_allow_direct_select = 1;
```

### Service updates
To implement the session recording, we're going to use an opensource library called [rrweb](https://github.com/rrweb-io/rrweb). You can read about that library in detail in the [Github repo](https://github.com/rrweb-io/rrweb), but to summarize the implementation, we need to:

- Inject the `rrweb` library into the webpage
- Initialize a session recording
- Post all recording events to our Hono service
- Produce the events to Redpanda and Clickhouse
- Build a page to replay the events

We could implement this in our `/js` endpoint, but for readability purposes, we're going to create a new endpoint called `record.js`. The implementation is shown below. Please add this new endpoint to your Hono service (the `index.ts` file) and read the comments to understand what the code is doing:

```js
app.get('/record.js', (c) => {
  const baseUrl = getBaseUrl(c)
  const saveUrl = `${baseUrl}/save-recording`

  const script = `
  // import the library
  import * as rrweb from 'https://esm.run/rrweb';

  // only record if we're not on the Admin page
  if (document.title != 'Admin') {
    
    // initialize the recording
    const stopFn = rrweb.record({
      emit(event) {
        const recording = {
          id: "${crypto.randomUUID()}",
          page_title: document.title,
          recording: event,
          timestamp: event?.timestamp
        }
        
        // POST the event to our Hono service
        fetch("${saveUrl}", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recording)
        });
      },
    });
  }
  `;
  return c.text(script, 200, { 'Content-Type': 'application/javascript' });
});
```

The code above will collect session recording events from the client, and `POST` them to a URL called `save-recording`. To implement the `/save-recording` endpoint, which simply needs to save the data to Redpanda, add the following lines of code to your Hono service:

```js
app.post('/save-recording', async (c) => {
  // parse the incoming request body
	const recording = await c.req.json()

  // write to Redpanda in the background
  c.executionCtx.waitUntil(produceToRedpanda(recording, 'session_recordings'))

  // acknowledge the event
  return c.text("ok")
});
```

We’ve already updated the example marketing site with the following line, ensuring that the session recording script is invoked on page load:

```
<script is:inline type="module" src="http://localhost:8787/record.js"></script>
```

The `type="module"` attribute is required for this script since we're importing `rrweb` using the following ES6 module syntax:

```js
import * as rrweb from 'https://esm.run/rrweb';
```

### Testing
To test the session recording feature, visit the [example marketing site](http://localhost:4321/pricing) and click around the pricing page.

Then, visit the [Admin page](http://localhost:4321/admin) to view the recordings. Typically, the session replayer would live on a separate, internal dashboard. We have added it to the marketing website for convenience.

If you want to know how the session replay feature was implemented:

- Check out the bonus endpoints we added to `index.ts`
- Look at the code for the `SessionRecordings.vue` component in the marketing website.

The implementation is pretty lightweight and simply involves pulling the saved recordings from Clickhouse, and passing the data to an open-source component called [rrweb-player](https://github.com/rrweb-io/rrweb-player).

```js
// SessionRecordings.vue
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';

// ...

new rrwebPlayer({
    target: document.getElementById('replay'),
    props: {
        events, // pulled from Clickhouse
    },
});
```




