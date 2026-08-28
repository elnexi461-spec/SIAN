import { logger } from '../logging';
import { sleep, jitter } from '../utils/helpers';

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private currentDelay: number;
  private readonly minDelay: number;
  private readonly maxDelay: number;

  constructor(targetRequestsPerSecond: number) {
    this.capacity = Math.max(targetRequestsPerSecond, 1);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.refillRate = this.capacity / 1000;
    this.minDelay = 1000 / this.capacity;
    this.maxDelay = 30000;
    this.currentDelay = this.minDelay;
  }

  async acquire(): Promise<void> {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await sleep(waitMs);
    this.tokens -= 1;
  }

  reportSuccess(): void {
    this.currentDelay = Math.max(this.minDelay, this.currentDelay * 0.9);
  }

  reportError(isRateLimit: boolean): void {
    if (isRateLimit) {
      this.currentDelay = Math.min(this.maxDelay, this.currentDelay * 2);
      logger.warn({ newDelay: this.currentDelay }, 'Rate limit hit, backing off');
    } else {
      this.currentDelay = Math.min(this.maxDelay, this.currentDelay * 1.2);
    }
  }

  getCurrentDelay(): number {
    return this.currentDelay;
  }

  private refill(): void {
    const now = Date.now();
    const delta = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillRate);
    this.lastRefill = now;
  }
}
