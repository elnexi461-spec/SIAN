# SIAN — Taobao / Tmall Product Data Engine

Production-oriented TypeScript extraction engine for Taobao and Tmall product data, designed for high-volume e-commerce collection with a direct acquisition path and a browser fallback when session state is required.

## Scope

SIAN is built around complete product-detail extraction rather than title/price-only scraping. The normalized Taobao model supports:

- Product title and category
- Current and original/tag pricing
- Product images and videos
- Brand and product properties
- Taobao vs Tmall shop type
- Shop identity and seller information
- Shop credit/evaluation data
- DSR evaluation scores
- SKU properties and variants
- SKU IDs, prices and stock quantities
- Review records
- Purchased variant information when exposed by Taobao
- Request, latency, retry, bandwidth and extraction metrics

## Acquisition Architecture

SIAN uses a layered acquisition strategy:

1. **Direct acquisition** — attempt the lowest-overhead Taobao data path first.
2. **Session-aware extraction** — reuse authenticated/session state when the direct path requires it.
3. **Browser fallback** — use a persistent Playwright/Browserbase browser session when page-level extraction or session state is required.
4. **Normalization** — convert the source response into a stable Taobao/Tmall product schema.
5. **Validation & storage** — validate extracted records, checkpoint jobs and persist normalized output.

The browser layer is intended as a fallback rather than the default per-item path so that throughput and operating cost can be measured and optimized for high-volume collection.

## Architecture Components

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
| Validation         |
+-------------------+
        |
        v
 JSON / JSONL / CSV
```

## Operational Features

- TypeScript / Node.js 20+
- Axios-based HTTP acquisition
- Playwright browser integration
- Persistent browser/session support
- Proxy-pool configuration
- Request rate limiting
- Retry handling
- Checkpointing and resumable jobs
- Queue/concurrency controls
- Structured logging
- Bandwidth and latency metrics
- JSON, JSONL and CSV output support
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

Copy the example environment file and configure the required acquisition/session settings for the environment being used.

```bash
cp .env.example .env
```

Do not commit credentials, session cookies, API secrets or proxy credentials.

## Benchmarking

SIAN is designed to benchmark the economics of high-volume Taobao/Tmall extraction, including:

- Bytes transferred per successful item
- Attempts per successful item
- Direct vs browser-fallback usage
- Items processed per authenticated identity/session
- Proxy usage and cost
- Average latency
- Estimated throughput
- Projected cost at 10,000 items/day

The benchmark should use real results; the README does not claim a fixed success rate or cost until those figures have been measured in the target environment.

## Project Status

The SIAN extraction engine and supporting infrastructure are under active development. Taobao/Tmall acquisition depends on the access method available to the deployment environment; direct acquisition is attempted first and the browser/session layer is available as the fallback path.

## License

MIT
