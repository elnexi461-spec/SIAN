import axios, { AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logging';
import { withRetry } from '../retry';
import { TaobaoItemDetail } from '../types/taobao';

const APP_KEY = '12574478';
const MTOP_API = 'mtop.taobao.detail.getdetail';
const MTOP_VERSION = '6.0';
const MTOP_JSV = '2.6.1';
const H5_API_URL = 'https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdetail/6.0/';

interface H5Token {
  token: string;
}

type UnknownRecord = Record<string, unknown>;
type TaobaoSkuCore = NonNullable<TaobaoItemDetail['skuCore']>;

export function generateMtopSign(token: string, timestamp: string, appKey: string, data: string): string {
  const signingInput = `${token}&${timestamp}&${appKey}&${data}`;
  return crypto.createHash('md5').update(signingInput, 'utf8').digest('hex');
}

export function extractMtopToken(cookieValue: string): string | undefined {
  const cookieMatch = cookieValue.match(/(?:^|;\s*)_m_h5_tk=([^;]*)/);
  const rawValue = cookieMatch ? cookieMatch[1] : cookieValue.includes('=') ? undefined : cookieValue;
  if (!rawValue) return undefined;

  const separatorIndex = rawValue.indexOf('_');
  const token = (separatorIndex === -1 ? rawValue : rawValue.slice(0, separatorIndex)).trim();
  return token || undefined;
}

export function buildMtopDetailRequest(
  itemId: string,
  token: string,
  timestamp: string,
  appKey: string = APP_KEY
): { data: string; sign: string; params: URLSearchParams } {
  const payload = { itemNumId: itemId };
  const data = JSON.stringify(payload);
  const sign = generateMtopSign(token, timestamp, appKey, data);
  const params = new URLSearchParams({
    jsv: MTOP_JSV,
    appKey,
    t: timestamp,
    sign,
    api: MTOP_API,
    v: MTOP_VERSION,
    type: 'jsonp',
    dataType: 'jsonp',
    callback: 'mtopjsonp1',
    data,
  });

  return { data, sign, params };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function getArray(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asSellerType(value: unknown): 'B' | 'C' | undefined {
  return value === 'B' || value === 'C' ? value : undefined;
}

function asDsrType(value: unknown): 'desc' | 'serv' | 'post' | undefined {
  return value === 'desc' || value === 'serv' || value === 'post' ? value : undefined;
}

export class TaobaoApiClient {
  private session = axios.create({
    timeout: config.requestTimeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://h5.m.taobao.com/',
    },
  });

  private tokenCache?: H5Token;
  private sessionCookies: Map<string, string> = new Map();

  /**
   * Fetch item detail from Taobao H5 API.
   * This uses the same endpoint as the mobile web site.
   * No login required — works with guest cookies.
   */
  async fetchItemDetail(itemId: string): Promise<{
    success: boolean;
    data?: TaobaoItemDetail;
    statusCode?: number;
    latencyMs: number;
    retries: number;
    error?: string;
    requiresBrowser?: boolean;
    bytesReceived?: number;
  }> {
    const startTime = Date.now();

    const result = await withRetry(
      async () => {
        // Step 1: Get or refresh H5 token
        const token = await this.getH5Token(itemId);

        // Step 2: Build the request from one exact serialized payload.
        const request = buildMtopDetailRequest(itemId, token.token, Date.now().toString());
        const url = `${H5_API_URL}?${request.params.toString()}`;

        const response = await this.session.get(url, {
          headers: {
            Cookie: this.getSessionCookieHeader(),
            'x-requested-with': 'XMLHttpRequest',
          },
          responseType: 'text',
        });
        this.updateSessionCookies(response.headers['set-cookie']);

        const bytesReceived = typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data).length;

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Parse JSONP: mtopjsonp1({...})
        const jsonp = typeof response.data === 'string' ? response.data : String(response.data);
        const match = jsonp.match(/^mtopjsonp1\((.*)\)$/s);
        if (!match) {
          // Check if it's an anti-bot response
          if (jsonp.includes('FAIL_SYS_TOKEN_EXOIRED') || jsonp.includes('令牌过期')) {
            this.tokenCache = undefined;
            throw new Error('TOKEN_EXPIRED: H5 token expired');
          }
          if (jsonp.includes('FAIL_SYS_TRAFFIC_LIMIT') || jsonp.includes('系统繁忙')) {
            throw new Error('RATE_LIMIT: Traffic limit');
          }
          if (jsonp.includes('FAIL_SYS_USER_VALIDATE') || jsonp.includes('访问被拒绝')) {
            throw new Error('BLOCKED: User validation required');
          }
          throw new Error('Invalid JSONP response');
        }

        const parsed = JSON.parse(match[1]) as unknown;
        if (!isRecord(parsed)) {
          throw new Error('Invalid JSONP payload');
        }

        const ret = getArray(parsed, 'ret');
        const retMsg = asString(ret[0]) || 'Unknown error';
        if (!retMsg.includes('SUCCESS')) {
          if (retMsg.includes('TOKEN') || retMsg.includes('令牌')) {
            this.tokenCache = undefined;
            throw new Error('TOKEN_EXPIRED: H5 token expired');
          }
          throw new Error('API error: MTOP request failed');
        }

        const detail = this.parseDetailData(itemId, parsed.data);
        return { detail, bytesReceived };
      },
      {
        maxRetries: config.maxRetries,
        baseDelayMs: 2000,
        maxDelayMs: 15000,
        backoffMultiplier: 2,
      },
      `taobao-detail-${itemId}`
    );

    const latencyMs = Date.now() - startTime;

    if (!result.success) {
      const error = result.error?.message;
      return {
        success: false,
        latencyMs,
        retries: result.retries,
        error,
        requiresBrowser: this.isSecurityChallenge(error),
      };
    }

    return {
      success: true,
      data: result.result?.detail,
      statusCode: 200,
      latencyMs,
      retries: result.retries,
      bytesReceived: result.result?.bytesReceived,
    };
  }

  /**
   * Parse a detail response captured from a real Taobao/Tmall browser session.
   * The browser may receive JSONP with a callback name different from the H5
   * client's fixed callback, so accept either JSON or any JSONP wrapper.
   */
  parseBrowserDetailResponse(itemId: string, responseBody: string): TaobaoItemDetail | undefined {
    const trimmed = responseBody.trim();
    const jsonText = trimmed.startsWith('{') || trimmed.startsWith('[')
      ? trimmed
      : trimmed.replace(/^[^(]+\(/, '').replace(/\)\s*;?\s*$/, '');

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!isRecord(parsed)) return undefined;
      const ret = getArray(parsed, 'ret');
      const retMsg = asString(ret[0]) || '';
      if (retMsg && !retMsg.includes('SUCCESS')) return undefined;
      return this.parseDetailData(itemId, parsed.data);
    } catch {
      return undefined;
    }
  }

  /**
   * Get H5 token by making a dummy request.
   * The first request returns a token in the Set-Cookie header.
   */
  private async getH5Token(itemId: string): Promise<H5Token> {
    if (this.tokenCache) return this.tokenCache;

    // Make a dummy request to get the token cookie
    const t = Date.now().toString();
    const data = JSON.stringify({ itemNumId: itemId });
    // Dummy sign — the API will reject it but set the cookie
    const dummySign = 'a'.repeat(32);

    const params = new URLSearchParams({
      jsv: MTOP_JSV,
      appKey: APP_KEY,
      t,
      sign: dummySign,
      api: MTOP_API,
      v: MTOP_VERSION,
      type: 'jsonp',
      dataType: 'jsonp',
      callback: 'mtopjsonp1',
      data,
    });

    const url = `${H5_API_URL}?${params.toString()}`;
    const response = await this.session.get(url, {
      headers: {
        Cookie: this.getSessionCookieHeader(),
      },
      responseType: 'text',
    });
    this.updateSessionCookies(response.headers['set-cookie']);

    const token = extractMtopToken(this.sessionCookies.get('_m_h5_tk') || '');
    if (!token) {
      throw new Error('Failed to obtain H5 token — anti-bot protection may be active');
    }

    this.tokenCache = { token };
    return this.tokenCache;
  }

  /**
   * Parse the nested Taobao detail response into a flat structure.
   */
  private parseDetailData(itemId: string, data: unknown): TaobaoItemDetail {
    if (!isRecord(data)) {
      throw new Error('Invalid item detail response data');
    }

    const item = getRecord(data, 'item');
    const seller = getRecord(data, 'seller');
    const skuBase = getRecord(data, 'skuBase');
    const skuCore = this.parseSkuCore(getRecord(getRecord(data, 'skuCore'), 'sku2info'));
    const rawPropGroups = getArray(getRecord(data, 'props'), 'groupProps');
    const rawProps = rawPropGroups.flatMap(group => Array.isArray(group) ? group : [group]);

    // Parse apiStack for price/stock
    let apiStackData: UnknownRecord = {};
    const apiStack = getArray(data, 'apiStack');
    const firstApiStack = isRecord(apiStack[0]) ? apiStack[0] : undefined;
    const apiStackValue = firstApiStack ? asString(firstApiStack.value) : undefined;
    if (apiStackValue) {
      try {
        const parsedApiStack = JSON.parse(apiStackValue) as unknown;
        if (isRecord(parsedApiStack)) {
          apiStackData = parsedApiStack;
        }
      } catch {
        apiStackData = {};
      }
    }

    const apiPrice = getRecord(apiStackData, 'price');
    const apiPriceDetails = getRecord(apiPrice, 'price');
    const apiExtraPrices = getArray(apiPrice, 'extraPrices');
    const itemPrice = getRecord(item, 'price');
    const priceInfo = asString(apiPriceDetails.priceText) || asString(itemPrice.priceText) || '';
    const firstOriginalPrice = isRecord(apiExtraPrices[0]) ? apiExtraPrices[0] : {};
    const originalPriceInfo = asString(firstOriginalPrice.priceText) || '';

    // Build SKU list
    const skus: TaobaoItemDetail['skuBase']['skus'] = getArray(skuBase, 'skus')
      .filter(isRecord)
      .map(sku => ({
        skuId: asString(sku.skuId) || '',
        propPath: asString(sku.propPath) || '',
      }));

    // Determine platform
    const feature = getRecord(data, 'feature');
    const isTmall = asSellerType(seller.sellerType) === 'B' || feature.tmwOverseasScene !== undefined;
    const platform = isTmall ? 'tmall' : 'taobao';

    return {
      itemId,
      title: asString(item.title) || '',
      images: getArray(item, 'images')
        .map(asString)
        .filter((img): img is string => Boolean(img))
        .map(img => img.startsWith('http') ? img : `https:${img}`),
      videos: getArray(item, 'videos').filter(isRecord).map(video => ({
        videoId: asString(video.videoId) || '',
        url: asString(video.url) || '',
        thumbnail: asString(video.videoThumbnailURL) || '',
      })),
      price: {
        priceMoney: asString(itemPrice.priceMoney) || priceInfo,
        priceText: priceInfo || asString(itemPrice.priceText) || '',
      },
      originalPrice: originalPriceInfo ? {
        priceMoney: originalPriceInfo,
        priceText: originalPriceInfo,
      } : undefined,
      vagueSellCount: asString(item.vagueSellCount),
      category: undefined, // Not directly available in H5 API
      shopInfo: {
        shopId: asString(seller.shopId) || '',
        shopName: asString(seller.shopName) || '',
        sellerId: asString(seller.sellerId) || asString(seller.userId) || '',
        sellerNick: asString(seller.sellerNick) || '',
        sellerType: asSellerType(seller.sellerType) || 'C',
        creditLevel: asString(seller.creditLevel),
        creditLevelIcon: asString(seller.creditLevelIcon),
        evaluates: getArray(seller, 'evaluates').filter(isRecord).flatMap(evaluate => {
          const type = asDsrType(evaluate.type);
          return type ? [{
            title: asString(evaluate.title) || '',
            score: asString(evaluate.score) || '',
            level: asString(evaluate.level) || '',
            levelText: asString(evaluate.levelText) || '',
            type,
          }] : [];
        }),
        pcShopUrl: this.normalizeUrl(seller.pcShopUrl),
        shopIcon: this.normalizeUrl(seller.shopIcon),
      },
      skuBase: {
        props: getArray(skuBase, 'props').filter(isRecord).map(prop => ({
          pid: asString(prop.pid) || '',
          name: asString(prop.name) || '',
          values: getArray(prop, 'values').filter(isRecord).map(value => ({
            vid: asString(value.vid) || '',
            name: asString(value.name) || '',
            image: this.normalizeUrl(value.image),
          })),
        })),
        skus,
      },
      skuCore,
      props: rawProps.filter(isRecord).map(prop => ({
        name: asString(prop.name) || asString(prop.key) || '',
        value: asString(prop.value) || asString(prop.val) || '',
      })).filter(prop => prop.name && prop.value),
      reviews: undefined, // Fetched separately
      reviewCount: undefined,
      platform,
      itemUrl: platform === 'tmall'
        ? `https://detail.tmall.com/item.htm?id=${itemId}`
        : `https://item.taobao.com/item.htm?id=${itemId}`,
    };
  }

  private parseSkuCore(value: unknown): TaobaoSkuCore | undefined {
    if (!isRecord(value)) return undefined;

    const skuCore: TaobaoSkuCore = {};
    for (const [skuId, rawSku] of Object.entries(value)) {
      if (!isRecord(rawSku)) continue;

      const rawPrice = getRecord(rawSku, 'price');
      const priceMoney = asString(rawPrice.priceMoney);
      const priceText = asString(rawPrice.priceText);
      const normalizedSku: TaobaoSkuCore[string] = {};
      if (priceMoney !== undefined || priceText !== undefined) {
        normalizedSku.price = {
          priceMoney: priceMoney || '',
          priceText: priceText || '',
        };
      }

      const quantity = asNumber(rawSku.quantity);
      if (quantity !== undefined) normalizedSku.quantity = quantity;
      const quantityText = asString(rawSku.quantityText);
      if (quantityText !== undefined) normalizedSku.quantityText = quantityText;
      const logisticsTime = asString(rawSku.logisticsTime);
      if (logisticsTime !== undefined) normalizedSku.logisticsTime = logisticsTime;
      skuCore[skuId] = normalizedSku;
    }

    return skuCore;
  }

  private normalizeUrl(value: unknown): string | undefined {
    const url = asString(value);
    if (!url) return undefined;
    return url.startsWith('http') ? url : `https:${url}`;
  }

  clearCache(): void {
    this.tokenCache = undefined;
    this.sessionCookies.delete('_m_h5_tk');
  }

  private isSecurityChallenge(error?: string): boolean {
    if (!error) return false;
    return /BLOCKED|USER_VALIDATE|X5|验证码|安全验证|访问被拒绝|anti-bot|challenge|captcha/i.test(error);
  }

  private getSessionCookieHeader(): string {
    return Array.from(this.sessionCookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private updateSessionCookies(setCookie?: string[]): void {
    if (!setCookie) return;

    for (const cookie of setCookie) {
      const pair = cookie.split(';', 1)[0];
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) continue;

      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      this.sessionCookies.set(name, value);
    }

    const token = extractMtopToken(this.sessionCookies.get('_m_h5_tk') || '');
    if (token) this.tokenCache = { token };
  }
}
