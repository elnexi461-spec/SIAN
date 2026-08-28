export type Platform = 'jd' | 'taobao' | 'tmall';

export interface ProductSku {
  skuId: string;
  sourceUrl: string;
  discoveredAt: string;
  platform?: Platform;
}

export interface WareBusinessResponse {
  [key: string]: unknown;
}

export interface NormalizedProduct {
  skuId: string;
  productName?: string;
  title?: string;
  price?: number;
  originalPrice?: number;
  currency?: string;
  brand?: string;
  category?: string;
  availability?: boolean;
  stockStatus?: string;
  shopId?: string;
  shopName?: string;
  isJdSelfRun?: boolean;
  imageUrl?: string;
  productUrl?: string;
  scrapedAt?: string;
}

export interface ScrapedRecord {
  id: string;
  skuId: string;
  sourceUrl: string;
  timestamp: string;
  platform: Platform;
  extractionMethod: 'direct-api' | 'browser-intercept' | 'fallback';
  requestStatus: number;
  latencyMs: number;
  rawResponse: WareBusinessResponse;
  normalized: NormalizedProduct;
  proxyUsed?: string;
  retryCount: number;
  bytesReceived?: number;
}

export interface MetricsSnapshot {
  totalDiscovered: number;
  totalProcessed: number;
  totalSuccessful: number;
  totalFailed: number;
  totalDuplicates: number;
  recordsPerSecond: number;
  recordsPerMinute: number;
  estimatedPerDay: number;
  activeWorkers: number;
  totalRetries: number;
  totalRequests: number;
  totalBandwidthBytes: number;
  extractionMethodDistribution: Record<string, number>;
  httpStatusDistribution: Record<number, number>;
  averageLatencyMs: number;
  estimatedCostUsd: number;
  queueSize: number;
  storageSize: number;
  uptimeSeconds: number;
}

export interface Checkpoint {
  jobId: string;
  discovered: number;
  processed: number;
  successful: number;
  failed: number;
  duplicates: number;
  timestamp: string;
  queuedSkus?: string[];
  inProgressSkus?: string[];
  failedSkus?: string[];
  completedSkus?: string[];
  seedSkuIds?: string[];
}

export interface ScraperConfig {
  concurrency: number;
  requestRate: number;
  maxRetries: number;
  requestTimeout: number;
  connectionTimeout: number;
  proxyPool: string[];
  sessionRotation: number;
  batchSize: number;
  outputFormat: 'json' | 'jsonl' | 'csv';
  databaseUrl: string;
  checkpointInterval: number;
  baseUrl: string;
  areaId: string;
  userAgent: string;
  redisUrl?: string;
  queueName: string;
}
