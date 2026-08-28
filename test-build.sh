#!/bin/bash
set -e

echo "Installing dependencies..."
npm install

echo "Building project..."
npm run build

echo "Build successful! Testing scraper with real SKU..."
echo "Running: npm run dev -- scrape --skus 100000000001"

# Run with timeout and capture output
timeout 30s npm run dev -- scrape --skus 100000000001 2>&1 | head -50 || true

echo "Test completed."
