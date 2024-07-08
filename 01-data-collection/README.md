# Chapter 1 - Intro
In Chapter 1 of the Redpanda Web Analytics course, we explore the following topics:

- A reference architecture for building an in-house analytics product
- Prerequisites for completing the course exercises
- A service for collecting data

## Architecture
Our analytics platform will leverage the following components:

- An edge service for collecting website events using Javascript
- An API handler that writes the raw data to Redpanda
- A real-time data warehouse (Clickhouse) for storing and querying the data
- A Grafana dashboard for visualizing the data

## Prerequisites
- [Node.js](https://nodejs.org/en) v20 or higher.
- A terminal for running commands
- A text editor for writing code (e.g. [VSCode](https://code.visualstudio.com/))
- [Docker](https://www.docker.com/products/docker-desktop/) for running local Redpanda and Clickhouse clusters

## Starting the Services
There are three services to start:

- Redpanda
- Clickhouse
- Grafana

You can start all of them at once by running the following command:

```sh
docker-compose up -d
```

## Data Collection
In this tutorial, we'll start off by capturing page visits for a website. The typical approach, and the one we'll be implementing here, involves adding a line of javascript to your website:

```html
<html>
  <head>
    <script src="http://your-endpoint/js"></script>
  </head>
</html>
```

When the webpage is loaded, the browser will load the JS file from the service we specify. This service will collect information about our web traffic and then save it to Redpanda.

## Service Implementation
We need to implement a lightweight service to intercept the request in our JS file, capture the client information, and send the data to Redpanda and Clickhouse.

To keep our service fast, we'll deploy it to the "edge." This just means we want to deploy our code globally on servers that are geographically close to our users (usually in a serverless environment).

There are many different edge runtimes, including:
- [Bun](https://github.com/oven-sh/bun)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Deno](https://deno.com/)
- [Fastly Compute](https://www.fastly.com/products/edge-compute)
- [AWS Lambda@Edge](https://aws.amazon.com/lambda/edge/)
- [Vercel](https://vercel.com/)

To keep our service as flexible as possible, we're going to write our code in a way that can be deployed to _any_ of the above services. We can accomplish this using a framework called [Hono](https://hono.dev/).

Our Hono application will intercept requests from our website and forward the corresponding analytics to Redpanda. From Redpanda, we can do a couple of things:
- Build real-time services to provide insights on the analytic data
- Save the data to Clickhouse for ad hoc queries

For this tutorial, we'll deploy our service to Cloudflare Workers, but after completing the tutorial, we encourage you to try other edge runtimes, as well.


## Create a Hono app
To collect front-end analytics and send that information to Redpanda and Clickhouse, we first need to create a Hono application.

From your command line, run the following command:

```
npm create hono@latest
```

When prompted:
- select `y` to install Hono
- name the target directory `demo`
- select `cloudflare-worker` for the template type
- select `y` to install the project dependencies
- choose the package manager of your choice (`npm` is a good default choice)

### Starting the Service
To start your new Hono service, run the following commands:

```sh
cd demo/

npm run dev
```

The output of the second command should indicate that the service is running:

```
⎔ Starting local server...
[wrangler:inf] Ready on http://localhost:8787
╭────────────────────────────────────────────────────────────────────────────────╮
│ [b open a       [d] open        [l turn off local    [c clear       [x] to     │
│   browser,         Devtools,      mode,                console,        exit    │
╰────────────────────────────────────────────────────────────────────────────────╯
```

Either type `b` to open the service in your browser, or visit the URL directly (e.g. [http://localhost:8787](http://localhost:8787)).

You should see the following text when opening the URL in your browser:

```
Hello Hono!
```

## Creating a Simple Webpage
To collect web analytics, we need to have a website. This could be your company's website, a personal blog, or anything else. For this tutorial, we've created a simple marketing website using a framework called [Astro](https://astro.build/), and we've saved it to the `marketing-site/` directory.

You can run this website locally by executing the following commands in your terminal:

```sh
cd marketing-site/ && npm run dev
```

The site will be running at [http://localhost:4321](http://localhost:4321/).

## Creating the Endpoints
Capturing page visits and storing this information in Redpanda can be done in a few simple steps.

Our example marketing website already includes a script that points to an endpoint called `/js`. You can find this code in [`marketing-site/src/layouts/Layout.astro`](../marketing-site/src/layouts/Layout.astro)

```html
<html lang="en">
  <head>
    <script is:inline src="http://localhost:8787/js"></script>
    ...
  </head>
</html>
```

> Note: the `is:inline` directive is specific to the Astro web framework we're using, but you can leave this out when integrating your script into other websites.

Therefore, we need to implement an endpoint called `/js` in our Hono application.

To do so, open the file called `src/index.ts`. This was created automatically when you initialized your project using `npm create hono@latest`, and contains the `Hello Hono!` text we saw in the previous section.

```ts
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

export default app
```

Right before the `export default app` line, add the following code to register a new route: `/js`:

```ts
app.get('/js', async (c) => {
  c.header('Content-Type', 'application/javascript');
  return c.text('alert("Hello, world!")')
});
```

If your local web server is still running, it will automatically reload and add the new endpoint. Otherwise, if you've stopped the Hono app, be sure to start it again using:

```sh
# run this if Hono is not running
npm run dev
```

Now, visit the new marketing site in your browser: [http://localhost:4321/](http://localhost:4321/):

You should see the following text:

```
Hello, world!
```

This confirms that our data collection endpoint is wired up to our website, but it's not doing much yet. Let's modify the code slightly so that we can extract some useful information about the page visit.

To get the current URL in Javascript, we can use `window.location.href`. We'll need to run this whenever someone visits the page, and `POST` this information back to our service, where we can store it in Redpanda. To accomplish this, update `/js` endpoint to return the following Javascript snippet.

```js
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
```

Refresh the marketing website and in the terminal that's running your Hono app, you'll see that a second request was made to `/track`:

```sh
[wrangler:inf] GET /js 200 OK (20ms)
[wrangler:inf] OPTIONS /track 204 Not Found (15ms)
[wrangler:inf] POST /track 404 Not Found (3ms
```

It's `404`ing now because we haven't implemented that endpoint yet. We'll do that next.

## Enriching the Payload
Besides the page title, there's more information that would be useful for collecting each time someone visits our website. For example:

- Client information
- IP address
- Geolocation

While we needed to collect the page URL client-side (using the JS snippet we returned from the `js/` endpoint), we can collect the rest of this data from the server side.

First, go ahead and add a placeholder for the `track/` endpoint, as shown below.

```js
app.post('/track', async (c) => {
  // parse the payload that contains the page URL

  // add more useful information (e.g. the operating system, IP address, etc)

  // save to Redpanda
});
```

You'll notice that the handler function `async (c) => {}` accepts a single parameter that we call `c`. This is a [Hono's context object](https://hono.dev/docs/api/context), which contains a wealth of information about the incoming request.


For example, we can look at the `user-agent` header (available in the Hono context) to get some information about the user's device and operating system.

Update the `/track` endpoint as follows:

```js
app.post('/track', async (c) => {
  // parse the payload that contains the page URL
  const { url } = await c.req.json()

  // parse the user agent
  const userAgent = c.req.header('user-agent')

  const data = { url, userAgent }
  console.log(data)

  return c.text("Ok")
});
```

Then, refresh the page: [http://localhost:4321/](http://localhost:4321/).

In your Hono service logs will reveal a more interesting payload:

```js
{
  url: 'http://localhost:4321/pricing',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
}
```

We can then use the excellent [`ua-parser`](https://www.npmjs.com/package/ua-parser-js) library to extract some important information from the user agent string (e.g. browser type, operating system, etc):

To do so, install the `ua-parser` library by running the following command from the `demo/` directory.

```sh
npm i ua-parser-js
```

To use the library, open `index.ts` again, and add the following import to the top of the file:

```ts
import { UAParser, IResult } from 'ua-parser-js'
```

Then, update the `/track` endpoint as follows:

```ts
import { UAParser, IResult } from 'ua-parser-js'

// ...

app.post('/track', async (c) => {
  // parse the payload that contains the page URL
  const { url } = await c.req.json()

  // parse the user agent
  const userAgent = c.req.header('user-agent')
  
  const parser = new UAParser(userAgent); // you need to pass the user-agent for nodejs
  const client: IResult = parser.getResult() as IResult;

  console.log({ url, client})

  return c.text("Ok")
});
```

Refresh the website again and take a look at the Hono service logs:

```js
{
  url: 'http://localhost:4321/pricing',
  client: {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    browser: { name: 'Chrome', version: '124.0.0.0', major: '124' },
    engine: { name: 'Blink', version: '124.0.0.0' },
    os: { name: 'Mac OS', version: '10.15.7' },
    device: { vendor: 'Apple', model: 'Macintosh', type: undefined },
    cpu: { architecture: undefined }
  }
}
```

This payload is starting to pretty good. But thinking ahead, the highly nested structure of the `client` field could complicate the way we query and process the data later on. So let's add the following helper function to flatten the structure. You can add this in `index.ts` (the same file you've been working in so far):

```js
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
```

Then, update the `/track` handler to invoke this new function to flatten the data.

```js
app.post('/track', async (c) => {
  // parse the payload that contains the page URL
  const { url } = await c.req.json()

  // parse the user agent
  const userAgent = c.req.header('user-agent')
  
  const parser = new UAParser(userAgent); // you need to pass the user-agent for nodejs
  const client: Record<string, any> = flattenObject(parser.getResult() as IResult);

  console.log({ url, ...client})

  return c.text("Ok")
});
```

Refreshing the website now will reveal the following payload in the Hono service logs (the values may change depending on what type of machine you are running):

```js
{
  url: 'http://localhost:4321/',
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  browser_name: 'Chrome',
  browser_version: '124.0.0.0',
  browser_major: '124',
  engine_name: 'Blink',
  engine_version: '124.0.0.0',
  os_name: 'Mac OS',
  os_version: '10.15.7',
  device_vendor: 'Apple',
  device_model: 'Macintosh',
  device_type: undefined,
  cpu_architecture: undefined
}
```


We're almost finished constructing the payload, but we'll add some finishing touches in the next section before writing to Redpanda.


### Finalizing the payload
Next, we'll add two more fields to the payload: `ip` and `country`. This is where our implementation gets a little Cloudflare-specific. While the main Hono application can be deployed to many different edge runtimes, the methods for accessing certain data points may differ according to the runtime.

The following methods for getting the IP address (`c.req.header("CF-Connecting-IP")`) and the user's country (`c.req.raw?.cf?.country`) in the code snippet below can be adapted accordingly if you decide to deploy your application elsewhere.

Update the `/track` route with the following code:

```js
app.post('/track', async (c) => {
  // parse the payload that contains the page URL
  const { url } = await c.req.json()

  // parse the user agent
  const userAgent = c.req.header('user-agent')
  
  const parser = new UAParser(userAgent); // you need to pass the user-agent for nodejs
  const client: IResult = parser.getResult() as IResult;

  // add the client's IP address and country of origin
  // note: you may need to adjust this for different runtimes (Deno, Bun, etc)
  const ip = c.req.header("CF-Connecting-IP") || '127.0.0.1'
  const country = c.req.raw?.cf?.country
  
  // throw a timestamp in there too
  const timestamp = Math.floor(new Date().getTime() / 1000)

  // combine with the IP address, country
  const data = { url, ip, country, client }

  console.log(data)

  return c.text("Ok")
});
```

Refreshing the page now will reveal our finalized payload with the `ip`, `country`, and also a `timestamp`:

```js
{
  url: 'http://localhost:4321/',
  ip: '127.0.0.1',
  country: 'US',
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  browser_name: 'Chrome',
  browser_version: '124.0.0.0',
  browser_major: '124',
  engine_name: 'Blink',
  engine_version: '124.0.0.0',
  os_name: 'Mac OS',
  os_version: '10.15.7',
  device_vendor: 'Apple',
  device_model: 'Macintosh',
  device_type: undefined,
  cpu_architecture: undefined,
  timestamp: 1720444488
}
```

You are now ready to start writing the data to Redpanda. Proceed to the next section to continue the tutorial.


