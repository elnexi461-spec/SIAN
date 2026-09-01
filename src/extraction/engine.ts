import { DirectApiClient } from '../network/direct-api';
import { BrowserInterceptExtractor } from '../network/browser-intercept';
import { TaobaoBrowserExtractor } from '../network/taobao-browser';
import { TaobaoApiClient } from '../network/taobao-api';
import { TaobaoReviewClient } from '../network/taobao-reviews';
import { ResponseValidator } from '../validation/validator';
import { ProductNormalizer } from '../normalization/normalizer';
import { TaobaoNormalizer } from '../normalization/taobao-normalizer';
import { ScrapedRecord, WareBusinessResponse, NormalizedProduct } from '../types';
import { logger } from '../logging';
import { generateId, nowISO } from '../utils/helpers';
import { config } from '../config';

import { Platform } from '../types';

export class ExtractionEngine {
  private directApi: DirectApiClient;
  private taobaoApi: TaobaoApiClient;
  private taobaoReviews: TaobaoReviewClient;
  private browserExtractor?: BrowserInterceptExtractor;
  private taobaoBrowserExtractor: TaobaoBrowserExtractor;
  private taobaoBrowserInitialization?: Promise<void>;
  private validator: ResponseValidator;
  private normalizer: ProductNormalizer;
  private taobaoNormalizer: TaobaoNormalizer;

  constructor() {
    this.directApi = new DirectApiClient();
    this.taobaoApi = new TaobaoApiClient();
    this.taobaoReviews = new TaobaoReviewClient();
    this.taobaoBrowserExtractor = new TaobaoBrowserExtractor();
    this.validator = new ResponseValidator();
    this.normalizer = new ProductNormalizer();
    this.taobaoNormalizer = new TaobaoNormalizer();
  }

  async extract(skuId: string, platform: Platform = 'jd', attemptBrowser = false): Promise<ScrapedRecord | null> {
    // Deterministic platform routing
    if (platform !== 'jd' && platform !== 'taobao' && platform !== 'tmall') {
      logger.warn({ platform }, 'Invalid platform, defaulting to jd');
      platform = 'jd';
    }
    if (platform === 'taobao' || platform === 'tmall') {
      return this.extractTaobao(skuId, platform, attemptBrowser);
    }
    return this.extractJd(skuId, attemptBrowser);
  }

  private async extractJd(skuId: string, attemptBrowser = false): Promise<ScrapedRecord | null> {
    const recordId = generateId();
    const startTime = Date.now();

    const directResult = await this.directApi.fetchWareBusiness(skuId);

    if (directResult.success && directResult.data) {
      const validation = this.validator.validateWareBusiness(directResult.data);
      if (validation.valid && validation.data) {
        const normalized = this.normalizer.normalize(skuId, validation.data);
        return {
          id: recordId,
          skuId,
          sourceUrl: `https://item.jd.com/${skuId}.html`,
          timestamp: nowISO(),
          platform: 'jd',
          extractionMethod: 'direct-api',
          requestStatus: directResult.statusCode || 200,
          latencyMs: directResult.latencyMs,
          rawResponse: validation.data,
          normalized,
          proxyUsed: directResult.proxyUsed,
          retryCount: directResult.retries,
          bytesReceived: directResult.bytesReceived,
        };
      }
    }

    if (attemptBrowser) {
      logger.info({ skuId }, 'Falling back to browser interception');
      try {
        if (!this.browserExtractor) {
          this.browserExtractor = new BrowserInterceptExtractor();
          await this.browserExtractor.initialize();
        }

        const browserData = await this.browserExtractor.extract(skuId);
        if (browserData) {
          const validation = this.validator.validateWareBusiness(browserData);
          if (validation.valid && validation.data) {
            const normalized = this.normalizer.normalize(skuId, validation.data);
            return {
              id: recordId,
              skuId,
              sourceUrl: `https://item.jd.com/${skuId}.html`,
              timestamp: nowISO(),
              platform: 'jd',
              extractionMethod: 'browser-intercept',
              requestStatus: 200,
              latencyMs: Date.now() - startTime,
              rawResponse: validation.data,
              normalized,
              retryCount: directResult.retries,
              bytesReceived: undefined,
            };
          }
        }
      } catch (err) {
        logger.error({ skuId, err }, 'Browser extraction failed');
      }
    }

    logger.warn({ skuId, directError: directResult.error }, 'All extraction levels failed');
    return null;
  }

  private async extractTaobao(itemId: string, platform: 'taobao' | 'tmall', attemptBrowser = false): Promise<ScrapedRecord | null> {
    const recordId = generateId();
    const startTime = Date.now();

    if (process.env.BROWSERBASE_API_KEY) {
      try {
        await this.prepareTaobaoBrowserSession(itemId, platform);
      } catch (err) {
        logger.warn({ itemId, err }, 'Taobao browser session preparation failed; using existing direct session behavior');
      }
    }

    // Step 1: Fetch item detail from H5 API
    const detailResult = await this.taobaoApi.fetchItemDetail(itemId);

    if (!detailResult.success || !detailResult.data) {
      logger.warn({ itemId, error: detailResult.error }, 'Taobao H5 API failed');
      if (attemptBrowser || detailResult.requiresBrowser) {
        return this.extractTaobaoFromBrowser(itemId, platform, recordId, startTime, detailResult.retries);
      }
      return null;
    }

    const validation = this.validator.validateTaobaoItemDetail(detailResult.data);
    if (!validation.valid || !validation.data) {
      logger.warn({ itemId, errors: validation.errors }, 'Taobao H5 response failed validation');
      if (attemptBrowser) {
        return this.extractTaobaoFromBrowser(itemId, platform, recordId, startTime, detailResult.retries);
      }
      return null;
    }

    try {
      return await this.buildTaobaoRecord(
        itemId,
        platform,
        recordId,
        startTime,
        validation.data,
        'direct-api',
        detailResult.retries,
        detailResult.statusCode || 200,
        detailResult.bytesReceived
      );
    } catch (err) {
      logger.warn({ itemId, err }, 'Taobao H5 normalization failed');
      if (attemptBrowser) {
        return this.extractTaobaoFromBrowser(itemId, platform, recordId, startTime, detailResult.retries);
      }
      return null;
    }
  }

  private async extractTaobaoFromBrowser(
    itemId: string,
    platform: 'taobao' | 'tmall',
    recordId: string,
    startTime: number,
    retries: number
  ): Promise<ScrapedRecord | null> {
    try {
      await this.ensureTaobaoBrowserInitialized();

      const browserResult = await this.taobaoBrowserExtractor.extract(itemId, platform);
      if (!browserResult) return null;

      const validation = this.validator.validateTaobaoItemDetail(browserResult.detail);
      if (!validation.valid || !validation.data) {
        logger.warn({ itemId, errors: validation.errors }, 'Taobao browser response failed validation');
        return null;
      }

      return this.buildTaobaoRecord(
        itemId,
        platform,
        recordId,
        startTime,
        validation.data,
        'browser-intercept',
        retries,
        200,
        browserResult.bytesReceived
      );
    } catch (err) {
      logger.error({ itemId, err }, 'Taobao browser extraction failed');
      return null;
    }
  }

  private async ensureTaobaoBrowserInitialized(): Promise<void> {
    if (!this.taobaoBrowserInitialization) {
      this.taobaoBrowserInitialization = this.taobaoBrowserExtractor.initialize();
    }
    await this.taobaoBrowserInitialization;
  }

  private async prepareTaobaoBrowserSession(
    itemId: string,
    platform: 'taobao' | 'tmall'
  ): Promise<void> {
    await this.ensureTaobaoBrowserInitialized();
    await this.taobaoBrowserExtractor.prepareSession(itemId, platform);
    this.taobaoApi.setSessionProvider(this.taobaoBrowserExtractor.createSessionProvider());
  }

  private async buildTaobaoRecord(
    itemId: string,
    platform: 'taobao' | 'tmall',
    recordId: string,
    startTime: number,
    detail: import('../types/taobao').TaobaoItemDetail,
    extractionMethod: 'direct-api' | 'browser-intercept',
    retries: number,
    requestStatus: number,
    bytesReceived?: number
  ): Promise<ScrapedRecord> {
    // Reviews remain best-effort; the product record never contains invented data.
    let reviews: any[] = [];
    let reviewCount: number | undefined;
    try {
      const reviewResult = await this.taobaoReviews.fetchReviews(itemId, platform === 'tmall');
      if (reviewResult.success && reviewResult.reviews) {
        reviews = reviewResult.reviews;
        reviewCount = reviewResult.reviewCount;
      }
    } catch (err) {
      logger.warn({ itemId, err }, 'Review fetch failed');
    }

    detail.reviews = reviews;
    detail.reviewCount = reviewCount;

    const normalized = this.taobaoNormalizer.normalize(itemId, detail);

    return {
      id: recordId,
      skuId: itemId,
      sourceUrl: detail.itemUrl,
      timestamp: nowISO(),
      platform,
      extractionMethod,
      requestStatus,
      latencyMs: Date.now() - startTime,
      rawResponse: detail as any,
      normalized: normalized as any,
      retryCount: retries,
      bytesReceived,
    };
  }

  async shutdown(): Promise<void> {
    await this.browserExtractor?.close();
    await this.taobaoBrowserExtractor?.close();
    this.taobaoApi.setSessionProvider(undefined);
    this.taobaoApi.clearCache();
  }
}
