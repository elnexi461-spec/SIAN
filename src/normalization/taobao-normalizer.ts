import { TaobaoItemDetail, TaobaoNormalizedProduct, TaobaoSku } from '../types/taobao';
import { logger } from '../logging';

export function parseTaobaoPrice(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const match = value
    .replace(/[,，]/g, '')
    .match(/-?(?:\d+(?:\.\d*)?|\.\d+)/);
  if (!match) return undefined;

  const price = Number(match[0]);
  return Number.isFinite(price) ? price : undefined;
}

export class TaobaoNormalizer {
  normalize(itemId: string, detail: TaobaoItemDetail): TaobaoNormalizedProduct {
    // Build specifications map
    const specifications: Record<string, string> = {};
    if (detail.props) {
      for (const prop of detail.props) {
        specifications[prop.name] = prop.value;
      }
    }

    // Build SKU list with resolved names
    const skus: TaobaoSku[] = [];
    const propMap = this.buildPropMap(detail.skuBase.props);

    for (const sku of detail.skuBase.skus) {
      const skuCore = detail.skuCore?.[sku.skuId];
      const propertiesName = this.resolvePropPath(sku.propPath, propMap);
      const price = parseTaobaoPrice(skuCore?.price?.priceMoney) ??
        parseTaobaoPrice(skuCore?.price?.priceText) ??
        parseTaobaoPrice(detail.price.priceMoney) ??
        parseTaobaoPrice(detail.price.priceText) ??
        0;
      const originalPrice = parseTaobaoPrice(detail.originalPrice?.priceMoney) ??
        parseTaobaoPrice(detail.originalPrice?.priceText);

      skus.push({
        skuId: sku.skuId,
        properties: sku.propPath,
        propertiesName,
        price,
        originalPrice,
        stock: skuCore?.quantity ?? null,
        stockText: skuCore?.quantityText,
        image: sku.image || this.findSkuImage(sku.propPath, propMap),
      });
    }

    // Extract DSR scores
    const dsrScores = this.extractDsrScores(detail.shopInfo.evaluates);

    // Extract brand from specifications
    const brand = specifications['品牌'] || specifications['Brand'] || undefined;

    // Calculate average shop score from DSR
    let shopScore: number | undefined;
    if (dsrScores) {
      shopScore = parseFloat(((dsrScores.description + dsrScores.service + dsrScores.logistics) / 3).toFixed(2));
    }

    const firstStock = skus[0]?.stock;
    const stockStatus = skus[0]?.stockText ||
      (firstStock === null || firstStock === undefined
        ? 'unknown'
        : firstStock > 0 ? 'in_stock' : 'out_of_stock');

    const normalized: TaobaoNormalizedProduct = {
      skuId: itemId,
      itemId,
      platform: detail.platform,
      title: detail.title,
      price: parseTaobaoPrice(detail.price.priceMoney) ?? parseTaobaoPrice(detail.price.priceText),
      originalPrice: parseTaobaoPrice(detail.originalPrice?.priceMoney) ??
        parseTaobaoPrice(detail.originalPrice?.priceText),
      currency: 'CNY',
      brand,
      category: detail.category,
      stockStatus,
      shopId: detail.shopInfo.shopId,
      shopName: detail.shopInfo.shopName,
      shopType: detail.shopInfo.sellerType === 'B' ? 'tmall' : 'taobao',
      shopScore,
      goodRate: undefined, // Not available in H5 API
      dsrScores,
      specifications,
      skus,
      reviews: detail.reviews || [],
      reviewCount: detail.reviewCount,
      images: detail.images,
      itemUrl: detail.itemUrl,
      scrapedAt: new Date().toISOString(),
    };

    logger.debug({ itemId, normalized }, 'Normalized Taobao product');
    return normalized;
  }

  private buildPropMap(props: TaobaoItemDetail['skuBase']['props']): Map<string, {
    name: string;
    values: Map<string, { name: string; image?: string }>;
  }> {
    const map = new Map<string, {
      name: string;
      values: Map<string, { name: string; image?: string }>;
    }>();
    for (const prop of props) {
      const valueMap = new Map<string, { name: string; image?: string }>();
      for (const v of prop.values) {
        valueMap.set(v.vid, { name: v.name, image: v.image });
      }
      map.set(prop.pid, { name: prop.name, values: valueMap });
    }
    return map;
  }

  private resolvePropPath(propPath: string, propMap: Map<string, {
    name: string;
    values: Map<string, { name: string; image?: string }>;
  }>): string {
    const parts = propPath.split(';').map(part => part.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex <= 0) {
        resolved.push(part);
        continue;
      }

      const pid = part.slice(0, separatorIndex);
      const vid = part.slice(separatorIndex + 1);
      const prop = propMap.get(pid);
      const value = prop?.values.get(vid);
      if (prop && value) {
        resolved.push(`${prop.name}:${value.name}`);
      } else {
        resolved.push(part);
      }
    }
    return resolved.join(';') || propPath;
  }

  private findSkuImage(propPath: string, propMap: Map<string, {
    name: string;
    values: Map<string, { name: string; image?: string }>;
  }>): string | undefined {
    const parts = propPath.split(';').map(part => part.trim()).filter(Boolean);
    for (const part of parts) {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex <= 0) continue;

      const pid = part.slice(0, separatorIndex);
      const vid = part.slice(separatorIndex + 1);
      const value = propMap.get(pid)?.values.get(vid);
      if (value?.image) {
        return value.image;
      }
    }
    return undefined;
  }

  private extractDsrScores(evaluates: TaobaoItemDetail['shopInfo']['evaluates']): { description: number; service: number; logistics: number } | undefined {
    if (!evaluates || evaluates.length === 0) return undefined;

    let description = 0;
    let service = 0;
    let logistics = 0;

    for (const e of evaluates) {
      const score = parseFloat(e.score) || 0;
      if (e.type === 'desc') description = score;
      if (e.type === 'serv') service = score;
      if (e.type === 'post') logistics = score;
    }

    if (description === 0 && service === 0 && logistics === 0) return undefined;

    return { description, service, logistics };
  }
}
