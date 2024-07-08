import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { UAParser, IResult } from 'ua-parser-js'

import { createClient } from '@clickhouse/client-web' // or '@clickhouse/client-web'

const client = createClient({
  /* configuration */
})

const app = new Hono()
app.use('/*', cors())

app.get('/', (c) => {
  return c.text('Hello Hono!')
})
app.get('/totals', async (c) => {
  const query = `
    SELECT ip, COUNT() as total
    FROM analytics.web
    GROUP BY ip
  `;
  const url = "http://localhost:8123/?query=";
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: query
    });

    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }
    return c.text(await response.text());
  } catch (error) {
    console.error(error);
    return c.text('Internal Server Error');
  }
});

function getBaseUrl(c) {
  const requestUrl = new URL(c.req.url);
  const port = requestUrl.port ? `:${requestUrl.port}` : '';
  return `${requestUrl.protocol}//${requestUrl.hostname}${port}`;
}

// chapter 1-2
app.get('/js', async (c) => {
  const baseUrl = getBaseUrl(c)
  c.header('Content-Type', 'application/javascript');

  return c.text(`
    const payload = {
      url: window.location.href
    }
    fetch("${baseUrl}/track", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  `)
});

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

// chapter 1-2
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

// chapter 3
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

// chapter 3
app.post('/save-recording', async (c) => {
  // parse the incoming request body
	const recording = await c.req.json()

  // write to Redpanda in the background
  c.executionCtx.waitUntil(produceToRedpanda(recording, 'session_recordings'))

  // acknowledge the event
  return c.text("ok")
});


function flattenObject(obj: IResult, parentKey: string = '', result: Record<string, any> = {}): Record<string, any> {
  Object.entries(obj).forEach(([key, value]) => {
      const newKey = parentKey ? `${parentKey}_${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          flattenObject(value as IResult, newKey, result);
      } else {
          result[newKey] = value;
      }
  });
  return result;
}

// bonus
app.get('/recordings', async (c) => {
  const sql = `
    SELECT
      id,
      page_title,
      max(timestamp) as latest_timestamp
    FROM analytics.recordings
    WHERE page_title != 'Admin'
    GROUP BY id, page_title
    ORDER BY latest_timestamp DESC
    LIMIT 50;
  `
  const resultSet = await client.query({
    query: sql,
    format: 'JSONEachRow',
  })

  const dataset = await resultSet.json() 
  return c.json(dataset)
});

app.get('/recordings/:id', async (c) => {
  const sql = `
    SELECT *
    FROM analytics.recordings
    WHERE id = {id: String}
    ORDER BY timestamp DESC;
  `
  const resultSet = await client.query({
    query: sql,
    format: 'JSONEachRow',
    query_params: {
      id: c.req.param('id')
    },
  })

  const dataset = await resultSet.json()
  return c.json(dataset)
});

export default app
