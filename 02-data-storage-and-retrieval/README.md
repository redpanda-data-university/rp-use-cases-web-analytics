# Chapter 2 - Data Storage and Retrieval
In Chapter 2 of the Redpanda Web Analytics course, we explore the following topics:

- Writing page visits from Hono to Redpanda
- Piping the data from Redpanda into Clickhouse
- Querying and visualizing the data using Grafana

## Setting up Redpanda
We have included a local Redpanda cluster in the `docker-compose.yml` file. To start the cluster, run the following command:

```
docker-compose up -d
```

Next, setup an alias to the `rpk` CLI. We'll use this CLI to create our topics and to verify that data is flowing through our Redpanda cluster.

With the cluster running, you're ready to create the topic that will store our analytics data. You can either create this from the Redpanda Console by visiting [http://localhost:8080](http://localhost:8080/topics) and creating a new topic called `website_visits` with `4` partitions, or you could use `rpk`:

```
rpk topic create website_visits -p 4
```

With the `website_visits` topic created, we're almost ready to write the data to Redpanda. However, since Redpanda gives us a couple of different options for producing data, we need to decide which method to use:

- The HTTP proxy allows us to produce requests by submitting HTTP requests to Redpanda's REST API
- Kafka producer libraries write data using a different wire format

Since Redpanda includes the HTTP proxy inside its binary, and Javascript has native support for making HTTP requests, we'll pursue that option in this tutorial. Another factor influencing our decision is that npm modules don't always work as expected in edge runtimes, so we'll pursue the path of least surprise by simply issuing HTTP requests instead of using one of the Kafka Node modules.

The Redpanda HTTP proxy should already be running at port `8082`. To list all of the topics in your Redpanda cluster, you can either visit [http://localhost:8082/topics](http://localhost:8082/topics) in your browser or run the following a curl command:

```
curl -s "localhost:8082/topics"
```

The output will include an internal `_schemas` topic, as well as the topic you just created earlier.

```sh
["website_visits","_schemas"]
```

Next, you'll produce the data to Redpanda.

## Producing to Redpanda

The [Redpanda documentation](https://docs.redpanda.com/current/develop/http-proxy/?tab=tabs-5-curl) includes many examples of how to interact with Redpanda's HTTP Proxy API. For example, to produce data to a Redpanda topic, we need to issue a `POST` request to the `topics/{topic_name}` endpoint.

Open the `index.ts` file in your Hono project again, and in the `/track` handler, add the following code right before the return statement.

```ts
app.get('/track', async (c) => {

  // ... existing code

  // produce data to Redpanda
  const body = JSON.stringify({
    "records": [
      {
        "value": data,
        "partition": 0
      }
    ]
  })
  const redpandaUrl = 'http://localhost:8082/topics/website_visits';

  await fetch(redpandaUrl, {
    method: "POST",
    headers: {
      "Content-Type": 'application/vnd.kafka.json.v2+json'
    },
    body: body,
  });

  return c.text("Ok")
```

As you can see, we're using Javascript's built-in [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) to issue a `POST` request (via the `fetch` method) to the local Redpanda proxy.

If you visit the [example marketing website again](http://localhost:4321/), your service will produce the analytics data to Redpanda. Confirm this by opening a new terminal and running the following `rpk` command to inspect the `website_visits` topic:

```
rpk topic consume website_visits
```

You should see the visitor information in the output:

```json
{
  "topic": "website_visits",
  "value": "{\"url\":\"http://localhost:4321/\",\"ip\":\"127.0.0.1\",\"country\":\"US\",\"ua\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\",\"browser_name\":\"Chrome\",\"browser_version\":\"124.0.0.0\",\"browser_major\":\"124\",\"engine_name\":\"Blink\",\"engine_version\":\"124.0.0.0\",\"os_name\":\"Mac OS\",\"os_version\":\"10.15.7\",\"device_vendor\":\"Apple\",\"device_model\":\"Macintosh\",\"timestamp\":1720444767}",
  "timestamp": 1720444768073,
  "partition": 0,
  "offset": 0
}
```

If you have `jq` on your machine, you could optionally pretty-print the payload:

```
rpk topic consume website_visits -n 1 -f '%v' | jq '.'
```

The output is shown below:
```json
{
  "url": "http://localhost:4321/",
  "ip": "127.0.0.1",
  "country": "US",
  "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "browser_name": "Chrome",
  "browser_version": "124.0.0.0",
  "browser_major": "124",
  "engine_name": "Blink",
  "engine_version": "124.0.0.0",
  "os_name": "Mac OS",
  "os_version": "10.15.7",
  "device_vendor": "Apple",
  "device_model": "Macintosh",
  "timestamp": 1720444767
}
```

Now that the page visit data is flowing through Redpanda, we can do a couple of things with it:

- Write the data to a data warehouse to visualize and query the data
- Start building event-driven systems to utilize this data for various business use cases

We'll start with the first option and show you how to ingest this data into Clickhouse.

## Setting up Clickhouse
[Clickhouse](https://github.com/ClickHouse/ClickHouse) is a popular analytics database that is great for low-latency queries on large analytic datasets. It's open-source and easy to get started with.

We've included a Clickhouse deployment in the `docker-compose.yaml` file, so it should have automatically started after you ran `docker-compose up -d`. To verify that it's running, run the following command from your terminal:

```sh
echo "SELECT 'Hello, ClickHouse!'" \
    | curl 'http://localhost:8123/?query=' -s --data-binary @-
```

You'll see the following output:

```sh
Hello, ClickHouse!
```

Clickhouse also has a UI, which you can visit at [http://localhost:8123/play](http://localhost:8123/play). This UI is where you'll running the rest of the queries in this section.

First, create a new database for storing our analytics data by running the following statement from the [Clickhouse UI](http://localhost:8123/play).

```sql
CREATE DATABASE analytics;
```

Next, create a Clickhouse table that uses [the Kafka table engine](https://clickhouse.com/docs/en/engines/table-engines/integrations/kafka) to read data from Redpanda into Clickhouse.

```sql
CREATE OR REPLACE TABLE analytics.web_kafka (
    url String,
    ip String,
    country String,
    ua String,
    browser_name String,
    browser_version String,
    browser_major String,
    engine_name String,
    engine_version String,
    os_name String,
    os_version String,
    device_vendor String,
    device_model String,
    timestamp DateTime
) ENGINE = Kafka SETTINGS
    kafka_broker_list = 'redpanda-1:9092',
    kafka_topic_list = 'website_visits',
    kafka_group_name = 'rp',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1;
```

Finally, we'll set up a materialized view so that we can query the data. Run the following command to do so:

```sql
CREATE MATERIALIZED VIEW analytics.web
ENGINE = Memory
AS
SELECT *
FROM analytics.web_kafka
SETTINGS
stream_like_engine_allow_direct_select = 1;
```

With the table and materialized view setup, the data can now flow from Redpanda into Clickhouse. Open the [example marketing website again](http://localhost:4321/) and click around a few pages. Then go back to the Clickhouse UI, and run the following query:

```sql
SELECT * FROM analytics.web LIMIT 10
```

You should see multiple rows of data.

You can also run aggregate queries like the following:

```sql
SELECT COUNT() as count, country
FROM analytics.web
GROUP BY country
```

Note: if you experience any issues creating these tables, you can always check the Clickhouse system errors with the following query:

```sql
SELECT * FROM system.errors;
```

Once you've confirmed that the data is flowing into Clickhouse, proceed to the next section to learn how to visualize the data in Grafana.


## Visualizing the Data
In order to extract real value from our analytics data, we need a way to visualize it. Fortunately, Clickhouse [integrates with many different data visualization tools](https://clickhouse.com/docs/en/integrations/data-visualization) to enable this functionality. For this tutorial, we'll be choosing a well-established open-source option for visualizing our data: [Grafana](https://github.com/grafana/grafana).

We've already installed Grafana for you in the `docker-compose.yml` file:

```yaml
  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
```

So when you started the services earlier using `docker-compose up -d`, you also started a local Grafana service.

You can access the Grafana dashboard by visiting [http://localhost:3000/](http://localhost:3000/). When prompted, sign in with the following credentials:

- User name: `admin`
- Password: `admin`

Next, click the [Add new connection](http://localhost:3000/connections/add-new-connection) link, and from the search, search for `Clickhouse`.

After the connection is installed, click the __Add new data source__ button in the top right. You'll need to configure the following settings:

- Server: `clickhouse`
- Port: `9000`

Click __Save and test__ and confirm that the data source is working.


Next, click [Dashboards](http://localhost:3000/dashboard/new?orgId=1) in the left navigation, and then click __Add visualization__. Select your new Clickhouse connection, and then from the __SQL Editor__ tab, type in the following query:

```sql
SELECT timestamp AS time, country, count() AS requests
FROM analytics.web
GROUP BY country, timestamp
ORDER BY timestamp
```

Click __Run Query__ to ensure it works, and then click __Apply__.

As an exercise for the reader, add a few more visualizations in Grafana by writing some additional queries. Some examples of visualizations you can add include:

- A chart showing the total number of page visits (not grouped)
- A chart showing the total number of page visits, grouped by URL
- A table number of page visits by browser type and version

Once you're ready, proceed to the next chapter to implement a more advanced feature: session recordings.


