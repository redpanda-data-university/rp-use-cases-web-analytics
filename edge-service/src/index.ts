import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { UAParser, IResult } from 'ua-parser-js'

import { createClient } from '@clickhouse/client-web'

const client = createClient({ url: 'http://clickhouse:8123' })

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
  const url = "http://clickhouse:8123/?query=";
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

  const redpandaUrl = `http://redpanda-1:28082/topics/${topic}`;

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
      -- the timestamp column overflows (epoch ms parsed as seconds), so use the rrweb event's own timestamp
      max(JSONExtractUInt(recording, 'timestamp')) as latest_timestamp
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
    -- rrweb needs events in chronological order to replay
    ORDER BY JSONExtractUInt(recording, 'timestamp') ASC;
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

// session replay page: lists recordings from Clickhouse and plays them with rrweb-player
app.get('/replay', (c) => {
  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Admin</title>
  <link rel="stylesheet" href="https://cdn.rrweb.com/rrweb-player/2.1.1/style.css">
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
    #list { width: 360px; overflow-y: auto; border-right: 1px solid #ddd; padding: 16px; box-sizing: border-box; }
    #list h1 { font-size: 18px; margin-top: 0; }
    #list a { display: block; padding: 8px; border-radius: 6px; color: inherit; text-decoration: none; }
    #list a:hover, #list a.active { background: #f0f0f5; }
    #list small { color: #777; }
    #replay { flex: 1; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="list"><h1>Recordings</h1></div>
  <div id="replay"><p>Select a recording</p></div>

  <script type="module">
    import rrwebPlayer from 'https://cdn.rrweb.com/rrweb-player/2.1.1/rrweb-player.js';

    const list = document.getElementById('list');
    const replay = document.getElementById('replay');
    let player = null;

    async function loadRecording(id) {
      list.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.id === id));
      history.replaceState(null, '', '?id=' + id);

      const rows = await (await fetch('/recordings/' + id)).json();
      // each row stores one rrweb event as a JSON string
      const events = rows.map((row) => JSON.parse(row.recording));

      player?.$destroy();
      replay.innerHTML = '';
      if (events.length < 2) {
        replay.textContent = 'Not enough events to replay this recording';
        return;
      }
      player = new rrwebPlayer({
        target: replay,
        props: { events, width: 1024, height: 576, autoPlay: true },
      });
    }

    const recordings = await (await fetch('/recordings')).json();
    for (const r of recordings) {
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.id = r.id;
      a.append(r.page_title || '(untitled)', document.createElement('br'));
      const when = document.createElement('small');
      when.textContent = new Date(Number(r.latest_timestamp)).toLocaleString() + ' · ' + r.id.slice(0, 8);
      a.append(when);
      a.onclick = (e) => { e.preventDefault(); loadRecording(r.id); };
      list.append(a);
    }

    const id = new URLSearchParams(location.search).get('id');
    if (id) loadRecording(id);
  </script>
</body>
</html>`)
});

export default app
