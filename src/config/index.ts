import dotenv from 'dotenv';
import { ScraperConfig } from '../types';

dotenv.config();

export const config: ScraperConfig = {
  concurrency: parseInt(process.env.CONCURRENCY || '16', 10),
  requestRate: parseInt(process.env.REQUEST_RATE || '50', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '15000', 10),
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '5000', 10),
  proxyPool: process.env.PROXY_POOL ? process.env.PROXY_POOL.split(',') : [],
  sessionRotation: parseInt(process.env.SESSION_ROTATION || '100', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
  outputFormat: (process.env.OUTPUT_FORMAT as any) || 'jsonl',
  databaseUrl: process.env.DATABASE_URL || 'sqlite:./data/scraper.db',
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '60', 10),
  baseUrl: process.env.JD_BASE_URL || 'https://item.jd.com',
  areaId: process.env.JD_AREA_ID || '1_2901_55554_0',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  redisUrl: process.env.REDIS_URL,
  queueName: process.env.QUEUE_NAME || 'jd-scraper-queue',
};

export default config;
