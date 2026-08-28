import { chromium, BrowserContext, Page, Response } from 'playwright';
import { mkdirSync } from 'fs';
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
  private context?: BrowserContext;
  private page?: Page;
  private currentItemId?: string;
  private capturedResponses = new Map<string, string[]>();
  private readonly apiParser = new TaobaoApiClient();

  async initialize(): Promise<void> {
    const profileDir = path.resolve(process.env.TAOBAO_PROFILE_DIR || '.taobao-browser-profile');
    mkdirSync(profileDir, { recursive: true });

    const headless = process.env.TAOBAO_BROWSER_HEADLESS === 'true';
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      userAgent: process.env.TAOBAO_BROWSER_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on('response', (response) => {
      void this.captureDetailResponse(response);
    });
    logger.info({ profileDir, headless }, 'Taobao persistent browser session opened');
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
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
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

    const timeoutMs = parseInt(process.env.TAOBAO_HUMAN_TIMEOUT_MS || '600000', 10);
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
            { itemId },
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