import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { Writable } from 'stream';
import { ScrapedRecord } from '../types';
import { logger } from '../logging';
import { config } from '../config';

export class StorageManager {
  private jsonlStream?: Writable;
  private recordCount = 0;
  private outputDir: string;
  private pendingWrites = 0;
  private maxPending = 100;
  private writeQueue: string[] = [];

  constructor(outputDir = './output') {
    this.outputDir = outputDir;
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    if (config.outputFormat === 'jsonl' || config.outputFormat === 'json') {
      const path = `${this.outputDir}/records-${Date.now()}.jsonl`;
      this.jsonlStream = createWriteStream(path, { flags: 'a' });
      logger.info({ path }, 'JSONL output stream initialized');
    }
  }

  async store(record: ScrapedRecord): Promise<void> {
    this.recordCount++;

    const line = JSON.stringify({
      ...record,
      rawResponse: record.rawResponse,
    }) + '\n';

    if (this.jsonlStream) {
      // Handle backpressure: if too many pending writes, queue and flush
      if (this.pendingWrites >= this.maxPending) {
        this.writeQueue.push(line);
        await this.drainQueue();
      } else {
        this.pendingWrites++;
        const canContinue = this.jsonlStream.write(line, (err) => {
          this.pendingWrites--;
          if (err) {
            logger.error({ err, skuId: record.skuId }, 'Write error');
          }
        });
        if (!canContinue) {
          await this.waitForDrain();
        }
      }
    }

    if (this.recordCount % config.checkpointInterval === 0) {
      logger.info({ recordCount: this.recordCount }, 'Checkpoint reached');
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.writeQueue.length > 0 && this.jsonlStream) {
      const line = this.writeQueue.shift()!;
      this.pendingWrites++;
      const canContinue = this.jsonlStream.write(line, () => {
        this.pendingWrites--;
      });
      if (!canContinue) {
        await this.waitForDrain();
      }
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.jsonlStream) {
        resolve();
        return;
      }
      this.jsonlStream.once('drain', () => resolve());
    });
  }

  async flush(): Promise<void> {
    await this.drainQueue();
    if (this.jsonlStream) {
      return new Promise((resolve) => {
        this.jsonlStream!.end(() => resolve());
      });
    }
  }

  getRecordCount(): number {
    return this.recordCount;
  }
}
