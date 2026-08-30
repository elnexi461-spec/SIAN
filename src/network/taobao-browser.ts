import { chromium, Browser, BrowserContext, Page, Response } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../logging';
import { TaobaoApiClient } from './taobao-api';
import { TaobaoItemDetail } from '../types/taobao';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

    const embeddedDetail = await this.extractEmbeddedProductData(itemId, platform);
    if (embeddedDetail) {
      logger.info({ itemId }, 'Extracted Taobao product data from embedded page JSON');
      return { detail: embeddedDetail };
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
      if (this.isLoginUrl()) {
        logger.warn({ itemId }, 'Taobao login required; stopping browser extraction');
        throw new Error('LOGIN_REQUIRED');
      }

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
      const hasEmbeddedProductData = await this.hasEmbeddedProductData();
      const hasProductContent = await this.hasProductContent();
      if (hasCapturedResponse || hasEmbeddedProductData || hasProductContent) return;

      await this.page.waitForTimeout(1000);
    }

    if (verificationWasSeen) {
      throw new Error(`Human verification did not complete within ${timeoutMs}ms`);
    }
    throw new Error(`Taobao product page did not load within ${timeoutMs}ms`);
  }

  private isLoginUrl(): boolean {
    if (!this.page) return false;
    const currentUrl = this.page.url().toLowerCase();
    return currentUrl.includes('login.taobao.com') || currentUrl.includes('login.tmall.com');
  }

  private async hasEmbeddedProductData(): Promise<boolean> {
    if (!this.page) return false;
    return this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      return Boolean(doc.querySelector(
        'script[type="application/json"], script[type="application/ld+json"], ' +
        'script[id*="initial" i], script[id*="state" i], script[id*="product" i], script[id*="item" i]'
      ));
    }).catch(() => false);
  }

  private async extractEmbeddedProductData(
    itemId: string,
    platform: 'taobao' | 'tmall'
  ): Promise<TaobaoItemDetail | undefined> {
    if (!this.page) return undefined;

    const payloads = await this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const scripts = Array.from(doc.scripts) as any[];
      return scripts
        .map(script => {
          const type = (script.getAttribute('type') || '').toLowerCase();
          const id = `${script.id} ${script.getAttribute('name') || ''} ${script.getAttribute('data-state') || ''}`;
          const text = script.textContent || '';
          const isJsonScript = type === 'application/json' || type === 'application/ld+json' || type.endsWith('+json');
          const isStateScript = /initial|state|product|item|detail|preload/i.test(id) ||
            /(?:__INITIAL_STATE__|__INITIAL_DATA__|INITIAL_STATE|initialState|itemData|productData|detailData)/.test(text);
          return isJsonScript || isStateScript ? text : '';
        })
        .filter(Boolean);
    }).catch(() => [] as string[]);

    for (const payload of payloads) {
      for (const candidate of this.parseEmbeddedPayloads(payload)) {
        const browserDetail = this.apiParser.parseBrowserDetailResponse(itemId, JSON.stringify(candidate));
        if (browserDetail) return browserDetail;

        const product = this.findEmbeddedProduct(candidate);
        if (!product) continue;

        const detail = this.mapEmbeddedProduct(itemId, platform, product);
        if (detail) return detail;
      }
    }

    return undefined;
  }

  private parseEmbeddedPayloads(payload: string): unknown[] {
    const trimmed = payload.trim();
    if (!trimmed) return [];

    const candidates: unknown[] = [];
    const addJson = (text: string) => {
      try {
        candidates.push(JSON.parse(text));
      } catch {
        // The script may be an assignment or a serialized JSON.parse call.
      }
    };

    addJson(trimmed);

    for (const encoded of this.extractJsonParseArguments(trimmed)) {
      try {
        addJson(encoded);
      } catch {
        // Continue looking for another serialized state value.
      }
    }

    let start = 0;
    while (start < trimmed.length) {
      const nextObject = trimmed.indexOf('{', start);
      const nextArray = trimmed.indexOf('[', start);
      const starts = [nextObject, nextArray].filter(index => index >= 0);
      if (starts.length === 0) break;

      const jsonStart = Math.min(...starts);
      const jsonText = this.extractBalancedJson(trimmed, jsonStart);
      if (!jsonText) break;
      addJson(jsonText);
      start = jsonStart + jsonText.length;
    }

    return candidates;
  }

  private extractJsonParseArguments(text: string): string[] {
    const values: string[] = [];
    let searchStart = 0;

    while (searchStart < text.length) {
      const callStart = text.indexOf('JSON.parse', searchStart);
      if (callStart < 0) break;

      const openParen = text.indexOf('(', callStart + 'JSON.parse'.length);
      if (openParen < 0) break;

      let index = openParen + 1;
      while (/\s/.test(text[index] || '')) index++;
      const quote = text[index];
      if (quote !== '"' && quote !== "'" && quote !== '`') {
        searchStart = openParen + 1;
        continue;
      }

      index++;
      let encoded = '';
      let closed = false;
      while (index < text.length) {
        const char = text[index];
        if (char === '\\' && index + 1 < text.length) {
          encoded += char + text[index + 1];
          index += 2;
          continue;
        }
        if (char === quote) {
          closed = true;
          break;
        }
        encoded += char;
        index++;
      }

      if (closed) {
        try {
          values.push(quote === '"'
            ? JSON.parse(`"${encoded}"`)
            : encoded.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r'));
        } catch {
          // Ignore malformed serialized values.
        }
      }
      searchStart = index + 1;
    }

    return values;
  }

  private extractBalancedJson(text: string, start: number): string | undefined {
    const opening = text[start];
    if (opening !== '{' && opening !== '[') return undefined;

    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let quote: '"' | "'" | undefined;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === opening) {
        depth++;
      } else if (char === closing) {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }

    return undefined;
  }

  private findEmbeddedProduct(value: unknown, depth = 0): UnknownRecord | undefined {
    if (depth > 8) return undefined;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this.findEmbeddedProduct(entry, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!isRecord(value)) return undefined;

    const type = asString(value['@type']);
    const hasProductShape = type?.toLowerCase() === 'product' ||
      Boolean(
        (isRecord(value.item) && (value.seller || value.shopInfo || value.skuBase)) ||
        value.title || value.name || value.itemTitle || value.itemName ||
        value.price || value.offers || value.images || value.image
      );
    if (hasProductShape) return value;

    for (const child of Object.values(value)) {
      if (isRecord(child)) {
        const found = this.findEmbeddedProduct(child, depth + 1);
        if (found) return found;
      } else if (Array.isArray(child)) {
        for (const entry of child) {
          const found = this.findEmbeddedProduct(entry, depth + 1);
          if (found) return found;
        }
      }
    }

    return undefined;
  }

  private mapEmbeddedProduct(
    itemId: string,
    platform: 'taobao' | 'tmall',
    product: UnknownRecord
  ): TaobaoItemDetail | undefined {
    const item = this.firstRecord(product, ['item', 'product', 'goods']) || product;
    const seller = this.firstRecord(product, ['shopInfo', 'seller', 'shop', 'store']) || {};
    const offers = this.firstRecord(product, ['offers', 'offer', 'priceInfo']) || {};
    const title = this.firstString(item, ['title', 'name', 'itemTitle', 'itemName', 'subject']) ||
      this.firstString(product, ['title', 'name', 'itemTitle', 'itemName', 'subject']) || '';
    const images = this.extractImages(item, product);
    const price = this.extractPrice(item, product, offers);

    if (!title && images.length === 0 && !price) return undefined;

    const skuBase = this.firstRecord(item, ['skuBase']) || {};
    const rawProps = asArray(skuBase.props).length > 0 ? asArray(skuBase.props) : asArray(item.props);
    const props = rawProps.filter(isRecord).map(prop => ({
      pid: this.firstString(prop, ['pid', 'id']) || '',
      name: this.firstString(prop, ['name', 'key', 'label']) || '',
      values: asArray(prop.values).filter(isRecord).map(value => ({
        vid: this.firstString(value, ['vid', 'id', 'valueId']) || '',
        name: this.firstString(value, ['name', 'value', 'label']) || '',
        image: this.normalizeEmbeddedUrl(this.firstString(value, ['image', 'img', 'imageUrl'])),
      })),
    })).filter(prop => prop.name || prop.values.length > 0);

    const rawSkus = asArray(skuBase.skus).length > 0 ? asArray(skuBase.skus) : asArray(item.skus);
    const skuCore = this.firstRecord(item, ['skuCore']) || {};
    const skus = rawSkus.filter(isRecord).map(sku => {
      const skuId = this.firstString(sku, ['skuId', 'id', 'sku']) || '';
      const core = isRecord(skuCore[skuId]) ? skuCore[skuId] : {};
      return {
        skuId,
        propPath: this.firstString(sku, ['propPath', 'properties', 'propertiesPath']) || '',
        core,
      };
    }).filter(sku => sku.skuId).map(sku => sku);

    const normalizedSkus = skus.map(sku => {
      const skuPrice = this.extractPrice(sku.core, sku.core, this.firstRecord(sku.core, ['price']) || {});
      const quantity = this.firstNumber(sku.core, ['quantity', 'stock', 'inventory']);
      return {
        skuId: sku.skuId,
        propPath: sku.propPath,
        ...(skuPrice ? { price: skuPrice } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        quantityText: this.firstString(sku.core, ['quantityText', 'stockText', 'inventoryText']),
        logisticsTime: this.firstString(sku.core, ['logisticsTime', 'deliveryTime']),
      };
    });

    const sellerType = this.firstString(seller, ['sellerType', 'shopType']) === 'B' || platform === 'tmall' ? 'B' : 'C';
    const itemUrl = this.normalizeEmbeddedUrl(
      this.firstString(item, ['itemUrl', 'url', 'link']) ||
      this.firstString(product, ['itemUrl', 'url', 'link'])
    ) || (platform === 'tmall'
      ? `https://detail.tmall.com/item.htm?id=${itemId}`
      : `https://item.taobao.com/item.htm?id=${itemId}`);

    return {
      itemId,
      title,
      images,
      price: price || { priceMoney: '', priceText: '' },
      originalPrice: this.extractOriginalPrice(item, product, offers),
      vagueSellCount: this.firstString(item, ['vagueSellCount', 'sales', 'sellCount', 'soldCount']),
      category: this.firstString(item, ['category', 'categoryName']),
      shopInfo: {
        shopId: this.firstString(seller, ['shopId', 'id', 'shop_id']) || '',
        shopName: this.firstString(seller, ['shopName', 'name', 'title']) || '',
        sellerId: this.firstString(seller, ['sellerId', 'userId', 'seller_id']) || '',
        sellerNick: this.firstString(seller, ['sellerNick', 'nick', 'nickname']) || '',
        sellerType,
        pcShopUrl: this.normalizeEmbeddedUrl(this.firstString(seller, ['pcShopUrl', 'url', 'shopUrl'])),
        shopIcon: this.normalizeEmbeddedUrl(this.firstString(seller, ['shopIcon', 'logo', 'icon'])),
      },
      skuBase: {
        props,
        skus: normalizedSkus.map(sku => ({ skuId: sku.skuId, propPath: sku.propPath })),
      },
      skuCore: normalizedSkus.length > 0
        ? Object.fromEntries(normalizedSkus.map(sku => [sku.skuId, {
          price: sku.price,
          quantity: sku.quantity,
          quantityText: sku.quantityText,
          logisticsTime: sku.logisticsTime,
        }]))
        : undefined,
      props: this.extractSimpleProps(item),
      platform,
      itemUrl,
    };
  }

  private extractImages(item: UnknownRecord, product: UnknownRecord): string[] {
    const rawImages = [
      ...asArray(item.images),
      ...asArray(product.images),
      item.image,
      item.mainImage,
      item.picUrl,
      item.pic_url,
      product.image,
      product.mainImage,
    ];

    return rawImages
      .flatMap(value => isRecord(value) ? [value.url, value.src, value.image] : [value])
      .map(asString)
      .filter((value): value is string => Boolean(value))
      .map(value => this.normalizeEmbeddedUrl(value) || value)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  private extractPrice(
    item: UnknownRecord,
    product: UnknownRecord,
    offers: UnknownRecord
  ): { priceMoney: string; priceText: string } | undefined {
    const priceObject = this.firstRecord(item, ['price']) || this.firstRecord(product, ['price']);
    const source = priceObject || offers;
    const priceMoney = this.firstString(source, ['priceMoney', 'money', 'centPrice']);
    const priceText = this.firstString(source, ['priceText', 'displayPrice', 'formattedPrice']);
    const rawPrice = priceMoney || priceText ||
      this.firstString(offers, ['price', 'lowPrice', 'minPrice']) ||
      this.firstString(product, ['price', 'lowPrice', 'minPrice']);

    if (!rawPrice) return undefined;
    const numeric = this.numericPrice(rawPrice);
    if (numeric === undefined) return undefined;
    const money = priceMoney ? numeric : Math.round(numeric * 100);
    return {
      priceMoney: String(money),
      priceText: priceText || rawPrice,
    };
  }

  private extractOriginalPrice(
    item: UnknownRecord,
    product: UnknownRecord,
    offers: UnknownRecord
  ): { priceMoney: string; priceText: string } | undefined {
    const source = this.firstRecord(item, ['originalPrice', 'marketPrice', 'listPrice']) ||
      this.firstRecord(product, ['originalPrice', 'marketPrice', 'listPrice']);
    const offerPrice = this.firstString(offers, ['highPrice', 'listPrice', 'marketPrice']);
    const raw = source
      ? this.firstString(source, ['priceMoney', 'priceText', 'price'])
      : offerPrice;
    if (!raw) return undefined;
    const numeric = this.numericPrice(raw);
    if (numeric === undefined) return undefined;
    const priceMoney = source && this.firstString(source, ['priceMoney', 'priceText'])
      ? numeric
      : Math.round(numeric * 100);
    return { priceMoney: String(priceMoney), priceText: raw };
  }

  private extractSimpleProps(item: UnknownRecord): Array<{ name: string; value: string }> {
    return asArray(item.props).filter(isRecord).map(prop => ({
      name: this.firstString(prop, ['name', 'key', 'label']) || '',
      value: this.firstString(prop, ['value', 'val', 'text']) || '',
    })).filter(prop => prop.name && prop.value);
  }

  private firstRecord(record: UnknownRecord, keys: string[]): UnknownRecord | undefined {
    for (const key of keys) {
      if (isRecord(record[key])) return record[key];
    }
    return undefined;
  }

  private firstString(record: UnknownRecord, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = asString(record[key]);
      if (value) return value;
    }
    return undefined;
  }

  private firstNumber(record: UnknownRecord, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
  }

  private numericPrice(value: string): number | undefined {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const numeric = Number(match[0]);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  private normalizeEmbeddedUrl(value?: string): string | undefined {
    if (!value) return undefined;
    return value.startsWith('http') ? value : `https:${value}`;
  }

  private async isVerificationRequired(): Promise<boolean> {
    if (!this.page) return false;

    const currentUrl = this.page.url().toLowerCase();
    if (this.isLoginUrl() || /captcha|checkcode|x5sec|security/.test(currentUrl)) {
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