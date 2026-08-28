# JD.com WAREBUSINESS Production Scraper

## Overview
Production-grade scraper for JD.com that captures real product data from the `item-soa.jd.com/getWareBusiness` API flow.

## Architecture
- **Level 1**: Direct HTTP API requests to `getWareBusiness`
- **Level 2**: Playwright browser interception when session state is required
- **Level 3**: Fallback browser extraction

## Installation
```bash
npm install
npm run build
