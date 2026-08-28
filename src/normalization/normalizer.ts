import { WareBusinessResponse, NormalizedProduct } from '../types';
import { logger } from '../logging';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export class ProductNormalizer {
  normalize(skuId: string, raw: WareBusinessResponse): NormalizedProduct {
    const price = this.extractPrice(raw);
    const stockStatus = this.extractStockStatus(raw);
    const isJdSelfRun = this.detectJdSelfRun(raw);

    const normalized: NormalizedProduct = {
      skuId,
      title: this.extractTitle(raw),
      brand: asString(getRecord(raw, 'brandInfo').name),
      category: this.extractCategory(raw),
      price: price.current,
      originalPrice: price.original,
      currency: 'CNY',
      stockStatus,
      shopId: asString(getRecord(getRecord(raw, 'shopInfo'), 'shop').shopId),
      shopName: asString(getRecord(getRecord(raw, 'shopInfo'), 'shop').shopName),
      isJdSelfRun,
      imageUrl: this.extractImage(raw),
      productUrl: `https://item.jd.com/${skuId}.html`,
      scrapedAt: new Date().toISOString(),
    };

    logger.debug({ skuId, normalized }, 'Normalized product');
    return normalized;
  }

  private extractPrice(raw: WareBusinessResponse): { current?: number; original?: number } {
    const price = getRecord(raw, 'price');
    const p = parseFloat(asString(price.p) || '0');
    const op = parseFloat(asString(price.op) || '0');
    const m = parseFloat(asString(price.m) || '0');
    
    return {
      current: p > 0 ? p : (op > 0 ? op : undefined),
      original: op > 0 ? op : (m > 0 ? m : undefined),
    };
  }

  private extractStockStatus(raw: WareBusinessResponse): string | undefined {
    const stockInfo = getRecord(raw, 'stockInfo');
    if (Object.keys(stockInfo).length === 0) return undefined;
    const isStock = asBoolean(stockInfo.isStock);
    const stockState = asNumber(stockInfo.stockState);
    if (isStock === false) return 'out_of_stock';
    if (stockState === 34) return 'in_stock';
    if (stockState === 36) return 'pre_sale';
    return isStock ? 'in_stock' : 'unknown';
  }

  private detectJdSelfRun(raw: WareBusinessResponse): boolean | undefined {
    const shopInfo = getRecord(raw, 'shopInfo');
    const shopId = asString(getRecord(shopInfo, 'shop').shopId);
    const venderId = asString(shopInfo.venderId);
    if (shopId === '1000000127' || venderId === '8888') return true;
    return undefined;
  }

  private extractTitle(raw: WareBusinessResponse): string | undefined {
    return asString(getRecord(raw, 'wareInfo').title) || asString(raw.name);
  }

  private extractCategory(raw: WareBusinessResponse): string | undefined {
    const cat = getRecord(raw, 'categoryInfo');
    const names = [cat.cat1Name, cat.cat2Name, cat.cat3Name]
      .map(asString)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join(' > ') : undefined;
  }

  private extractImage(raw: WareBusinessResponse): string | undefined {
    const ware = getRecord(raw, 'wareInfo');
    return asString(ware.imageUrl) || asString(ware.mainImage);
  }
}
