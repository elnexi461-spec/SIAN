import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../logging';
import { WareBusinessResponse } from '../types';

export class BrowserInterceptExtractor {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private capturedResponses: Map<string, WareBusinessResponse> = new Map();

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await this.context.newPage();

    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('getWareBusiness') || url.includes('warebusiness')) {
        try {
          const body = await response.json();
          const skuMatch = url.match(/skuId=(\d+)/);
          if (skuMatch) {
            this.capturedResponses.set(skuMatch[1], body as WareBusinessResponse);
            logger.debug({ skuId: skuMatch[1], url }, 'Intercepted WAREBUSINESS response');
          }
        } catch {
          // Not JSON, ignore
        }
      }
    });
  }

  async extract(skuId: string): Promise<WareBusinessResponse | undefined> {
    if (!this.page) throw new Error('Browser not initialized');

    this.capturedResponses.delete(skuId);
    
    await this.page.goto(`https://item.jd.com/${skuId}.html`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    await new Promise(r => setTimeout(r, 2000));

    return this.capturedResponses.get(skuId);
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}
