import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { logger } from '../logging';
import { SessionManager } from '../session';
import { ProxyRotator } from '../proxy';
import { RateLimiter } from '../rate-limit';
import { withRetry, classifyError, ErrorCategory } from '../retry';
import { WareBusinessResponse } from '../types';

export class DirectApiClient {
  private sessionManager: SessionManager;
  private proxyRotator: ProxyRotator;
  private rateLimiter: RateLimiter;

  constructor() {
    this.sessionManager = new SessionManager();
    this.proxyRotator = new ProxyRotator();
    this.rateLimiter = new RateLimiter(config.requestRate);
  }

  async fetchWareBusiness(skuId: string, areaId?: string): Promise<{
    success: boolean;
    data?: WareBusinessResponse;
    statusCode?: number;
    latencyMs: number;
    proxyUsed?: string;
    retries: number;
    error?: string;
    bytesReceived?: number;
  }> {
    const startTime = Date.now();

    const result = await withRetry(
      async () => {
        await this.rateLimiter.acquire();

        const proxy = this.proxyRotator.getNextProxy();
        const axiosConfig: AxiosRequestConfig = {
          params: {
            skuId,
            area: areaId || config.areaId,
            num: 1,
          },
          headers: {
            Referer: `https://item.jd.com/${skuId}.html`,
          },
          responseType: 'json',
          // Allow up to 10MB response
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 10 * 1024 * 1024,
        };

        if (proxy) {
          axiosConfig.proxy = {
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            auth: proxy.auth,
          };
        }

        const session = this.sessionManager.getSession();
        const response = await session.get('https://item-soa.jd.com/getWareBusiness', axiosConfig);

        const bytesReceived = typeof response.data === 'string'
          ? response.data.length
          : JSON.stringify(response.data).length;

        if (response.status === 200) {
          if (typeof response.data === 'string' && response.data.includes('系统繁忙')) {
            throw new Error('RATE_LIMIT: System busy (系统繁忙)');
          }
          return {
            data: response.data as WareBusinessResponse,
            statusCode: response.status,
            proxyUsed: proxy ? `${proxy.host}:${proxy.port}` : undefined,
            bytesReceived,
          };
        }

        if (response.status === 429 || response.status === 503) {
          throw new Error(`RATE_LIMIT: HTTP ${response.status}`);
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      },
      {
        maxRetries: config.maxRetries,
        baseDelayMs: 2000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
      },
      `warebusiness-${skuId}`
    );

    const latencyMs = Date.now() - startTime;

    if (!result.success) {
      const category = classifyError(result.error);
      this.rateLimiter.reportError(category === ErrorCategory.RATE_LIMIT);

      return {
        success: false,
        latencyMs,
        retries: result.retries,
        error: result.error?.message,
      };
    }

    this.rateLimiter.reportSuccess();
    return {
      success: true,
      data: result.result?.data,
      statusCode: result.result?.statusCode,
      latencyMs,
      proxyUsed: result.result?.proxyUsed,
      retries: result.retries,
      bytesReceived: result.result?.bytesReceived,
    };
  }
}
