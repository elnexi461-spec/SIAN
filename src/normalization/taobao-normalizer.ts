import { TaobaoItemDetail, TaobaoNormalizedProduct, TaobaoSku } from '../types/taobao';
import { logger } from '../logging';

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

      skus.push({
        skuId: sku.skuId,
        properties: sku.propPath,
        propertiesName,
        price: skuCore?.price ? parseFloat(skuCore.price.priceMoney) / 100 : parseFloat(detail.price.priceMoney) / 100,
        originalPrice: detail.originalPrice ? parseFloat(detail.originalPrice.priceMoney) / 100 : undefined,
        stock: skuCore?.quantity ?? null,
        stockText: skuCore?.quantityText,
        image: this.findSkuImage(sku.propPath, propMap),
      });
    }

    // If no SKUs, add a default one
    if (skus.length === 0) {
      skus.push({
        skuId: itemId,
        properties: '',
        propertiesName: '默认',
        price: parseFloat(detail.price.priceMoney) / 100 || 0,
        stock: detail.skuCore?.['0']?.quantity ?? null,
        stockText: detail.skuCore?.['0']?.quantityText,
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

    const normalized: TaobaoNormalizedProduct = {
      skuId: itemId,
      itemId,
      platform: detail.platform,
      title: detail.title,
      price: parseFloat(detail.price.priceMoney) / 100 || undefined,
      originalPrice: detail.originalPrice ? parseFloat(detail.originalPrice.priceMoney) / 100 : undefined,
      currency: 'CNY',
      brand,
      category: detail.category,
      stockStatus: skus[0]?.stockText || (skus[0]?.stock && skus[0].stock > 0 ? 'in_stock' : 'unknown'),
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

  private buildPropMap(props: TaobaoItemDetail['skuBase']['props']): Map<string, Map<string, { name: string; image?: string }>> {
    const map = new Map<string, Map<string, { name: string; image?: string }>>();
    for (const prop of props) {
      const valueMap = new Map<string, { name: string; image?: string }>();
      for (const v of prop.values) {
        valueMap.set(v.vid, { name: v.name, image: v.image });
      }
      map.set(prop.pid, valueMap);
    }
    return map;
  }

  private resolvePropPath(propPath: string, propMap: Map<string, Map<string, { name: string; image?: string }>>): string {
    const parts = propPath.split(';');
    const resolved: string[] = [];
    for (const part of parts) {
      const [pid, vid] = part.split(':');
      const propName = propMap.get(pid);
      if (propName) {
        const value = propName.get(vid);
        if (value) {
          resolved.push(`${propName.get('__name__')?.name || pid}:${value.name}`);
        }
      }
    }
    return resolved.join(';') || propPath;
  }

  private findSkuImage(propPath: string, propMap: Map<string, Map<string, { name: string; image?: string }>>): string | undefined {
    const parts = propPath.split(';');
    for (const part of parts) {
      const [pid, vid] = part.split(':');
      const prop = propMap.get(pid);
      if (prop) {
        const value = prop.get(vid);
        if (value?.image) {
          return value.image;
        }
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
