#!/usr/bin/env node
import { Command } from 'commander';
import { WorkerPool } from '../workers';
import { MemoryJobQueue } from '../queue';
import { ExtractionEngine } from '../extraction/engine';
import { StorageManager } from '../storage';
import { MetricsCollector } from '../metrics';
import { CheckpointManager } from '../checkpoint';
import { ProductDiscovery } from '../discovery';
import { logger } from '../logging';
import { config } from '../config';
import { Platform } from '../types';

const program = new Command();

program
  .name('jd-scraper')
  .description('JD.com / Taobao / Tmall production scraper')
  .version('1.0.0');

program
  .command('scrape')
  .description('Start scraping products')
  .option('-s, --skus <skus...>', 'Seed SKU/Item IDs')
  .option('-p, --platform <platform>', 'Platform: jd, taobao, or tmall', 'jd')
  .option('-c, --concurrency <n>', 'Worker concurrency', String(config.concurrency))
  .option('-r, --rate <n>', 'Requests per second', String(config.requestRate))
  .option('-o, --output <dir>', 'Output directory', './output')
  .action(async (options) => {
    const platform = options.platform as 'jd' | 'taobao' | 'tmall';
    if (!['jd', 'taobao', 'tmall'].includes(platform)) {
      console.error(`Invalid platform: ${platform}. Must be jd, taobao, or tmall.`);
      process.exit(1);
    }

    const queue = new MemoryJobQueue();
    const engine = new ExtractionEngine();
    const storage = new StorageManager(options.output);
    const metrics = new MetricsCollector();
    const checkpoint = new CheckpointManager();
    const discovery = new ProductDiscovery();

    const pool = new WorkerPool(queue, engine, storage, metrics, checkpoint, discovery);

    const shutdown = async () => {
      await pool.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (options.skus && options.skus.length > 0) {
      const baseUrl = platform === 'jd'
        ? 'https://item.jd.com'
        : (platform === 'tmall' ? 'https://detail.tmall.com' : 'https://item.taobao.com');

      queue.enqueue(options.skus.map((id: string) => ({
        skuId: id,
        sourceUrl: `${baseUrl}/${platform === 'jd' ? '' : 'item.htm?id='}${id}`,
        discoveredAt: new Date().toISOString(),
        platform: platform as Platform,
      })));
      metrics.incrementDiscovered(options.skus.length);
    }

    await pool.start();
  });

program
  .command('server')
  .description('Start API server')
  .option('-p, --port <n>', 'Server port', '3000')
  .action(async (options) => {
    const { ScraperServer } = await import('../api');
    const server = new ScraperServer(parseInt(options.port, 10));
    server.start();
  });

program.parse();
