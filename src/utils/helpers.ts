import { v4 as uuidv4 } from 'uuid';

export function generateId(): string {
  return uuidv4();
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function jitter(baseMs: number, variance = 0.3): number {
  const jitterAmount = baseMs * variance * (Math.random() * 2 - 1);
  return Math.max(0, baseMs + jitterAmount);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function sanitizeSkuId(input: string): string | null {
  const cleaned = input.trim().replace(/[^\d]/g, '');
  return cleaned.length >= 5 && cleaned.length <= 20 ? cleaned : null;
}

export function buildProductUrl(skuId: string): string {
  return `https://item.jd.com/${skuId}.html`;
}

export function estimateDailyRate(recordsPerSecond: number): number {
  return Math.floor(recordsPerSecond * 60 * 60 * 24);
}
