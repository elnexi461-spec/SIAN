import { chromium, Browser, BrowserContext, Page, Response } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../logging';
import { TaobaoApiClient } from './taobao-api';
import { TaobaoItemDetail } from '../types/taobao';

export interface TaobaoBrowserExtraction {
  detail: TaobaoItemDetail;
  bytesReceived?: number;
}

/**
 * Human-in-the-loop browser fallback for Taobao/Tmall.
 *
 * This deliberately does not interact with CAPTCHA/X5 controls. It only
 * detects a verification page and waits for the person using the visible,
 * persistent browser session to complete it.
 */
export class TaobaoBrowserExtractor {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private currentItemId?: string;
  private capturedResponses = new Map<string, string[]>();
  private readonly apiParser = new TaobaoApiClient();
  private browserbaseSessionId?: string;
  private browserbaseApiKey?: string;
  private liveViewUrl?: string;

  async initialize(): Promise<void> {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY is not configured');
    }

    const profileDir = path.resolve(process.env.TAOBAO_PROFILE_DIR || '.taobao-browser-profile');
    mkdirSync(profileDir, { recursive: true });
    this.browserbaseApiKey = apiKey;

    const contextId = await this.getOrCreateBrowserbaseContext(profileDir);
    const session = await this.browserbaseRequest<{
      id: string;
      connectUrl: string;
    }>('/v1/sessions', 'POST', {
      browserSettings: {
        context: {
          id: contextId,
          persist: true,
        },
        viewport: { width: 1440, height: 1000 },
      },
      keepAlive: true,
    });

    if (!session.id || !session.connectUrl) {
      throw new Error('Browserbase did not return a usable browser session');
    }

    this.browserbaseSessionId = session.id;

    const liveView = await this.browserbaseRequest<{
      debuggerFullscreenUrl: string;
    }>(`/v1/sessions/${session.id}/debug`, 'GET');
    if (!liveView.debuggerFullscreenUrl) {
      throw new Error('Browserbase did not return a debuggerFullscreenUrl');
    }
    this.liveViewUrl = liveView.debuggerFullscreenUrl;

    this.browser = await chromium.connectOverCDP(session.connectUrl);
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error('Browserbase session has no default context');
    }

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on('response', (response) => {
      void this.captureDetailResponse(response);
    });

    logger.info(
      {
        sessionId: session.id,
        sessionUrl: `https://browserbase.com/sessions/${session.id}`,
        liveViewUrl: this.liveViewUrl,
      },
      'Taobao Browserbase session opened; use the live view for manual verification'
    );
  }

  async extract(itemId: string, platform: 'taobao' | 'tmall'): Promise<TaobaoBrowserExtraction | undefined> {
    if (!this.page) throw new Error('Taobao browser not initialized');

    this.currentItemId = itemId;
    this.capturedResponses.delete(itemId);
    const url = platform === 'tmall'
      ? `https://detail.tmall.com/item.htm?id=${itemId}`
      : `https://item.taobao.com/item.htm?id=${itemId}`;

    logger.info({ itemId, url }, 'Opening real Taobao product page');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await this.waitForVerificationAndProduct(itemId);

    const responseBodies = this.capturedResponses.get(itemId) || [];
    for (const body of responseBodies) {
      const detail = this.apiParser.parseBrowserDetailResponse(itemId, body);
      if (detail) {
        return {
          detail,
          bytesReceived: body.length,
        };
      }
    }

    const domDetail = await this.extractVisibleProductData(itemId, platform);
    if (domDetail) {
      logger.info({ itemId }, 'Extracted Taobao product data from browser page');
      return { detail: domDetail };
    }

    logger.warn({ itemId }, 'Taobao browser page contained no usable product data');
    return undefined;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    if (this.browserbaseSessionId && this.browserbaseApiKey) {
      try {
        await this.browserbaseRequest(`/v1/sessions/${this.browserbaseSessionId}`, 'POST', {});
      } catch (err) {
        logger.warn({ sessionId: this.browserbaseSessionId, err }, 'Browserbase session release failed');
      }
    }
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.browserbaseSessionId = undefined;
    this.browserbaseApiKey = undefined;
  }

  private async getOrCreateBrowserbaseContext(profileDir: string): Promise<string> {
    const configuredContextId = process.env.BROWSERBASE_CONTEXT_ID;
    if (configuredContextId) return configuredContextId;

    const contextFile = path.join(profileDir, 'browserbase-context-id');
    if (existsSync(contextFile)) {
      const savedContextId = readFileSync(contextFile, 'utf8').trim();
      if (savedContextId) return savedContextId;
    }

    const context = await this.browserbaseRequest<{ id: string }>('/v1/contexts', 'POST', {
      name: 'sian-taobao',
    });
    if (!context.id) throw new Error('Browserbase did not return a persistent context ID');

    writeFileSync(contextFile, `${context.id}\n`, { mode: 0o600 });
    return context.id;
  }

  private async browserbaseRequest<T = unknown>(
    requestPath: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.browserbaseApiKey) throw new Error('Browserbase API key is not configured');

    const response = await fetch(`https://api.browserbase.com${requestPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bb-api-key': this.browserbaseApiKey,
      },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Browserbase ${method} ${requestPath} failed with HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async captureDetailResponse(response: Response): Promise<void> {
    const url = response.url();
    if (!this.isDetailResponse(url) || !this.currentItemId) return;

    try {
      const body = await response.text();
      if (!body) return;
      const itemId = this.extractItemId(url) || this.currentItemId;
      const bodies = this.capturedResponses.get(itemId) || [];
      bodies.push(body);
      this.capturedResponses.set(itemId, bodies);
    } catch {
      // Some browser responses cannot be read after the page has closed.
    }
  }

  private async waitForVerificationAndProduct(itemId: string): Promise<void> {
    if (!this.page) return;

    const configuredTimeoutMs = parseInt(process.env.TAOBAO_HUMAN_TIMEOUT_MS || '600000', 10);
    const timeoutMs = Number.isFinite(configuredTimeoutMs)
      ? Math.max(600000, configuredTimeoutMs)
      : 600000;
    const deadline = Date.now() + timeoutMs;
    let verificationReported = false;
    let verificationWasSeen = false;

    while (Date.now() < deadline) {
      const verificationRequired = await this.isVerificationRequired();
      if (verificationRequired) {
        verificationWasSeen = true;
        if (!verificationReported) {
          verificationReported = true;
          logger.warn(
            { itemId, sessionId: this.browserbaseSessionId, liveViewUrl: this.liveViewUrl },
            'Human verification required in the open Taobao browser; complete it manually to resume extraction'
          );
        }
        await this.page.waitForTimeout(1000);
        continue;
      }

      if (verificationWasSeen) {
        logger.info({ itemId }, 'Human verification cleared; resuming Taobao extraction');
        await this.page.waitForTimeout(1500);
      }

      const hasCapturedResponse = (this.capturedResponses.get(itemId) || []).length > 0;
      const hasProductContent = await this.hasProductContent();
      if (hasCapturedResponse || hasProductContent) return;

      await this.page.waitForTimeout(1000);
    }

    if (verificationWasSeen) {
      throw new Error(`Human verification did not complete within ${timeoutMs}ms`);
    }
    throw new Error(`Taobao product page did not load within ${timeoutMs}ms`);
  }

  private async isVerificationRequired(): Promise<boolean> {
    if (!this.page) return false;

    const currentUrl = this.page.url().toLowerCase();
    if (
      currentUrl.includes('login.taobao.com') ||
      currentUrl.includes('login.tmall.com') ||
      /captcha|checkcode|x5sec|security/.test(currentUrl)
    ) {
      return true;
    }

    const state = await this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const bodyText = doc.body?.innerText || '';
      const challengeSelector = [
        '.nc-container',
        '#nc_1_n1',
        '[class*="captcha"]',
        '[id*="captcha"]',
        'iframe[src*="captcha"]',
        '[class*="verify"]',
      ].some(selector => {
        const element = doc.querySelector(selector) as { offsetParent?: unknown } | null;
        return Boolean(element && element.offsetParent !== null);
      });
      const hasPasswordField = Boolean(doc.querySelector('input[type="password"]'));
      const loginText = /登录|手机号|账号/.test(bodyText);
      return {
        challengeText: /安全验证|滑动验证|滑块验证|请完成验证|验证后继续|访问验证|验证码|captcha|robot check|x5/i.test(bodyText),
        challengeSelector,
        loginPage: hasPasswordField && loginText,
      };
    }).catch(() => ({ challengeText: false, challengeSelector: false, loginPage: false }));

    return state.challengeText || state.challengeSelector || state.loginPage;
  }

  private async hasProductContent(): Promise<boolean> {
    if (!this.page) return false;
    return this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const title = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
        doc.querySelector('h1')?.textContent ||
        doc.querySelector('[class*="item-title"]')?.textContent;
      return Boolean(title && title.trim() && !/验证|captcha|登录|login/i.test(title));
    }).catch(() => false);
  }

  private async extractVisibleProductData(
    itemId: string,
    platform: 'taobao' | 'tmall'
  ): Promise<TaobaoItemDetail | undefined> {
    if (!this.page) return undefined;

    const visible = await this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const text = (selector: string): string | undefined => {
        const value = doc.querySelector(selector)?.textContent?.trim();
        return value || undefined;
      };
      const attr = (selector: string, name: string): string | undefined => {
        const value = doc.querySelector(selector)?.getAttribute(name)?.trim();
        return value || undefined;
      };

      const title = attr('meta[property="og:title"]', 'content') ||
        text('h1') ||
        text('[class*="item-title"]') ||
        text('[class*="tb-detail-hd"]');
      const image = attr('meta[property="og:image"]', 'content') ||
        attr('meta[property="og:image:url"]', 'content') ||
        attr('.tb-thumb img', 'src') ||
        attr('[class*="image"] img', 'src');
      const priceText = attr('meta[property="product:price:amount"]', 'content') ||
        text('.tm-price') ||
        text('.tb-rmb-num') ||
        text('[class*="price"]');
      const shopName = text('.slogo-shopname') || text('[class*="shop-name"]');
      return { title, image, priceText, shopName };
    }).catch(() => undefined);

    if (!visible || (!visible.title && !visible.priceText && !visible.image)) return undefined;

    const price = this.toMoneyInCents(visible.priceText);
    const image = visible.image && (visible.image.startsWith('http') ? visible.image : `https:${visible.image}`);
    const itemUrl = this.page.url();

    return {
      itemId,
      title: visible.title || '',
      images: image ? [image] : [],
      price: {
        priceMoney: price?.money || '',
        priceText: visible.priceText || '',
      },
      shopInfo: {
        shopId: '',
        shopName: visible.shopName || '',
        sellerId: '',
        sellerNick: '',
        sellerType: platform === 'tmall' ? 'B' : 'C',
      },
      skuBase: { props: [], skus: [] },
      props: [],
      platform,
      itemUrl,
    };
  }

  private toMoneyInCents(priceText?: string): { money: string } | undefined {
    if (!priceText) return undefined;
    const match = priceText.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!match) return undefined;
    const amount = Number(match[1]);
    return Number.isFinite(amount) ? { money: String(Math.round(amount * 100)) } : undefined;
  }

  private isDetailResponse(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('mtop.taobao.detail.getdetail') ||
      lower.includes('detail.getdetail') ||
      (lower.includes('h5api.m.taobao.com/h5/') && lower.includes('detail'));
  }

  private extractItemId(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      for (const key of ['itemNumId', 'itemId', 'auctionNumId']) {
        const direct = parsed.searchParams.get(key);
        if (direct && /^\d+$/.test(direct)) return direct;
      }
      const data = parsed.searchParams.get('data');
      const match = data?.match(/(?:itemNumId|itemId|auctionNumId)["':=]+(\d+)/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}