import express, { Express, Request, Response } from 'express';
import { WorkerPool } from '../workers';
import { MemoryJobQueue } from '../queue';
import { ExtractionEngine } from '../extraction/engine';
import { StorageManager } from '../storage';
import { MetricsCollector } from '../metrics';
import { CheckpointManager } from '../checkpoint';
import { ProductDiscovery } from '../discovery';
import { logger } from '../logging';
import { sanitizeSkuId } from '../utils/helpers';

export class ScraperServer {
  private app: Express;
  private pool?: WorkerPool;
  private metrics: MetricsCollector;
  private queue: MemoryJobQueue;
  private engine: ExtractionEngine;
  private storage: StorageManager;
  private checkpoint: CheckpointManager;
  private discovery: ProductDiscovery;
  private port: number;
  private isRunning = false;

  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.queue = new MemoryJobQueue();
    this.engine = new ExtractionEngine();
    this.storage = new StorageManager('./output');
    this.metrics = new MetricsCollector();
    this.checkpoint = new CheckpointManager();
    this.discovery = new ProductDiscovery();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', running: this.isRunning });
    });

    this.app.get('/api/metrics', (_req: Request, res: Response) => {
      const snapshot = this.metrics.getSnapshot();
      res.json(snapshot);
    });

    this.app.post('/api/scrape/start', async (req: Request, res: Response) => {
      try {
        const { skus } = req.body as { skus?: string[] };
        if (this.isRunning) {
          return res.status(400).json({ error: 'Scraper already running' });
        }

        this.isRunning = true;
        this.pool = new WorkerPool(this.queue, this.engine, this.storage, this.metrics, this.checkpoint, this.discovery);
        
        this.pool.on('record', (record) => {
          logger.info({ skuId: record.skuId, success: true }, 'Record scraped');
        });

        this.pool.start(skus).catch(err => {
          logger.error({ err }, 'Pool error');
          this.isRunning = false;
        });

        res.json({ status: 'started', skus: skus?.length || 0 });
      } catch (err) {
        logger.error({ err }, 'Start error');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/scrape/stop', async (req: Request, res: Response) => {
      try {
        if (!this.pool) {
          return res.status(400).json({ error: 'No active scraper' });
        }
        await this.pool.stop();
        this.isRunning = false;
        res.json({ status: 'stopped' });
      } catch (err) {
        logger.error({ err }, 'Stop error');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/api/scrape/add', (req: Request, res: Response) => {
      try {
        const { skus } = req.body as { skus?: string[] };
        if (!skus || skus.length === 0) {
          return res.status(400).json({ error: 'No SKUs provided' });
        }

        const validated = skus.map(s => sanitizeSkuId(s)).filter((s): s is string => !!s);
        if (validated.length === 0) {
          return res.status(400).json({ error: 'No valid SKUs' });
        }

        this.queue.enqueue(validated.map(id => ({
          skuId: id,
          sourceUrl: `https://item.jd.com/${id}.html`,
          discoveredAt: new Date().toISOString(),
        })));

        res.json({ added: validated.length });
      } catch (err) {
        logger.error({ err }, 'Add SKU error');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/status', (_req: Request, res: Response) => {
      const snapshot = this.metrics.getSnapshot();
      const stats = this.queue.getStats();
      res.json({
        running: this.isRunning,
        metrics: snapshot,
        queue: stats,
      });
    });
  }

  start(): void {
    this.app.listen(this.port, () => {
      logger.info({ port: this.port }, 'API server started');
    });
  }
}
