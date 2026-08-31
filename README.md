# SIAN - Taobao / Tmall Product Data Engine

SIAN is a TypeScript and Node.js extraction engine for collecting detailed product data from Taobao and Tmall. It is built for cases where a simple title and price scraper is not enough and the product needs to be collected with its specifications, SKUs, shop information and reviews.

## What SIAN collects

The data model covers:

- Product title and category
- Current price and original/tag price
- Product images and videos
- Brand and product properties
- Taobao or Tmall shop type
- Shop and seller information
- Shop credit and evaluation data
- DSR scores
- SKU properties and variants
- SKU IDs, prices and stock
- Reviews
- Purchased variant information when it is available from the source

The engine also keeps track of request attempts, latency, bandwidth and extraction results so the collection process can be measured rather than guessed.

## How it works

SIAN uses a layered approach so that a browser is not required for every item.

1. **Direct acquisition** - Try the lowest-overhead available data source first.
2. **Session-aware extraction** - Reuse an authenticated session when the source requires one.
3. **Browser fallback** - Use Playwright with a persistent browser session when page access or session state requires it.
4. **Normalization** - Convert the collected data into a consistent Taobao/Tmall format.
5. **Validation and storage** - Check the result, save it, and support checkpoints and resumable jobs.

The goal is to keep browser usage as a fallback where possible, which makes it easier to measure bandwidth, throughput and operating cost at larger volumes.

## Architecture

```text
Input item IDs / URLs
        |
        v
+-------------------+
| Acquisition Layer |
+-------------------+
        |
   +----+----+
   |         |
Direct    Browser
   |      fallback
   +----+----+
        |
        v
+-------------------+
| Extraction / Parse|
+-------------------+
        |
        v
+-------------------+
| Normalization     |
+-------------------+
        |
        v
+-------------------+
| Validation        |
+-------------------+
        |
        v
 JSON / JSONL / CSV
```

## Current features

- TypeScript / Node.js 20+
- Axios-based HTTP acquisition
- Playwright browser integration
- Persistent browser and session support
- Proxy-pool configuration
- Request rate limiting
- Retry handling
- Checkpointing and resumable jobs
- Queue and concurrency controls
- Structured logging
- Bandwidth and latency metrics
- JSON, JSONL and CSV output
- Zod-based validation

## Installation

```bash
npm install
npm run build
```

## Development

```bash
npm run dev
```

Run the API service:

```bash
npm run api
```

Run tests:

```bash
npm test
```

## Configuration

Copy the example environment file and add the acquisition and session settings required by your deployment.

```bash
cp .env.example .env
```

Keep credentials, session cookies, API secrets and proxy credentials out of the repository.

## Benchmarking

The project is also being built with high-volume collection in mind. The benchmark records real results for:

- Bytes transferred per successful item
- Attempts per successful item
- Direct versus browser-fallback usage
- Items processed per authenticated session
- Proxy usage and cost
- Average latency
- Throughput
- Estimated cost at 10,000 items per day

No fixed success rate or operating cost is claimed until it has been tested with real Taobao/Tmall data.

## Project status

SIAN is under active development. The extraction and supporting infrastructure are in place, while the final Taobao/Tmall acquisition method depends on the access available to the deployment environment. Direct acquisition is preferred when it works, with session-aware and browser-based extraction available when needed.

## License

MIT
