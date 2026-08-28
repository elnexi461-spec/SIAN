import axios from 'axios';
import { logger } from '../logging';
import { withRetry } from '../retry';
import { TaobaoReview } from '../types/taobao';

type UnknownRecord = Record<string, unknown>;

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

export class TaobaoReviewClient {
  private session = axios.create({
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://h5.m.taobao.com/',
    },
  });

  /**
   * Fetch first page of reviews for a Taobao/Tmall item.
   * Uses the public rate/list_detail_rate endpoint.
   */
  async fetchReviews(itemId: string, isTmall: boolean): Promise<{
    success: boolean;
    reviews?: TaobaoReview[];
    reviewCount?: number;
    error?: string;
  }> {
    const result = await withRetry(
      async () => {
        let url: string;
        let responseType: string;

        if (isTmall) {
          // Tmall review endpoint
          url = `https://rate.tmall.com/list_detail_rate.htm?itemId=${itemId}&sellerId=1&currentPage=1&order=1&content=1&callback=jsonp_reviews`;
          responseType = 'text';
        } else {
          // Taobao review endpoint
          url = `https://rate.taobao.com/feedRateList.htm?auctionNumId=${itemId}&currentPageNum=1&pageSize=20&orderType=sort_weight&callback=jsonp_reviews`;
          responseType = 'text';
        }

        const response = await this.session.get(url, { responseType: responseType as any });

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }

        const jsonp = response.data as string;

        // Parse JSONP
        const match = jsonp.match(/jsonp_reviews\((.*)\)/s);
        if (!match) {
          // Some endpoints return plain JSON
          try {
            const plain = JSON.parse(jsonp) as unknown;
            return this.parseReviews(plain, isTmall);
          } catch {
            throw new Error('Invalid review response format');
          }
        }

        const parsed = JSON.parse(match[1]) as unknown;
        return this.parseReviews(parsed, isTmall);
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      },
      `taobao-reviews-${itemId}`
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error?.message || 'Unknown error',
      };
    }

    return {
      success: true,
      reviews: result.result?.reviews,
      reviewCount: result.result?.reviewCount,
    };
  }

  private parseReviews(data: unknown, isTmall: boolean): { reviews: TaobaoReview[]; reviewCount?: number } {
    if (!isRecord(data)) {
      return { reviews: [] };
    }

    if (isTmall) {
      const rateDetail = getRecord(data, 'rateDetail');
      const rateList = getArray(rateDetail, 'rateList');
      const paginator = getRecord(rateDetail, 'paginator');
      const rateCount = getRecord(rateDetail, 'rateCount');
      const reviewCount = asNumber(paginator.items) ?? asNumber(rateCount.total);

      return {
        reviews: rateList.filter(isRecord).map(review => {
          const auctionSku = asString(review.auctionSku);
          return {
            rateId: asString(review.id) || asString(review.rateId) || '',
            buyerNick: asString(review.displayUserNick) || asString(review.buyerNick) || '',
            rateContent: asString(review.rateContent) || '',
            rateDate: asString(review.rateDate) || '',
            skuInfo: auctionSku || asString(review.skuInfo),
            displayRatePic: asString(review.displayRatePic),
            auctionSku,
          };
        }),
        reviewCount,
      };
    } else {
      // Taobao format
      const comments = getArray(data, 'comments');
      const reviewCount = asNumber(data.total) ?? asNumber(data.totalCount);

      return {
        reviews: comments.filter(isRecord).map(review => {
          const user = getRecord(review, 'user');
          const auction = getRecord(review, 'auction');
          const auctionSku = asString(auction.sku);
          return {
            rateId: asString(review.rateId) || asString(review.id) || '',
            buyerNick: asString(user.nick) || asString(review.buyerNick) || '',
            rateContent: asString(review.content) || asString(review.rateContent) || '',
            rateDate: asString(review.date) || asString(review.rateDate) || '',
            skuInfo: auctionSku || asString(review.skuInfo),
            displayRatePic: undefined,
            auctionSku,
          };
        }),
        reviewCount,
      };
    }
  }
}
