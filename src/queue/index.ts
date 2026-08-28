import { EventEmitter } from 'events';
import { ProductSku, Platform } from '../types';
import { logger } from '../logging';

export interface Job {
  id: string;
  skuId: string;
  sourceUrl: string;
  platform?: Platform;
  priority: number;
  attempts: number;
  createdAt: string;
}

export class MemoryJobQueue extends EventEmitter {
  private queue: Job[] = [];
  private inProgress: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private failed: Set<string> = new Set();

  enqueue(skus: ProductSku[], priority = 5): void {
    for (const sku of skus) {
      if (this.completed.has(sku.skuId) || this.inProgress.has(sku.skuId)) {
        continue;
      }
      this.queue.push({
        id: `${sku.skuId}-${Date.now()}`,
        skuId: sku.skuId,
        sourceUrl: sku.sourceUrl,
        platform: sku.platform,
        priority,
        attempts: 0,
        createdAt: sku.discoveredAt,
      });
    }
    this.emit('enqueued', skus.length);
  }

  dequeue(): Job | undefined {
    if (this.queue.length === 0) return undefined;
    this.queue.sort((a, b) => b.priority - a.priority);
    const job = this.queue.shift();
    if (job) {
      this.inProgress.add(job.skuId);
    }
    return job;
  }

  complete(job: Job): void {
    this.inProgress.delete(job.skuId);
    this.completed.add(job.skuId);
    this.emit('completed', job);
  }

  fail(job: Job, maxRetries: number): boolean {
    this.inProgress.delete(job.skuId);
    if (job.attempts < maxRetries) {
      job.attempts++;
      this.queue.push(job);
      this.emit('retry', job);
      return true;
    }
    this.failed.add(job.skuId);
    this.emit('failed', job);
    return false;
  }

  getStats() {
    return {
      queued: this.queue.length,
      inProgress: this.inProgress.size,
      completed: this.completed.size,
      failed: this.failed.size,
    };
  }

  getFailedJobs(): string[] {
    return Array.from(this.failed);
  }
}
