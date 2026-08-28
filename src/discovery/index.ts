import axios from 'axios';
import { logger } from '../logging';
import { ProductSku } from '../types';

export class ProductDiscovery {
  private knownCategories = [
    '9987,653,655',
    '670,671,672',
    '737,794,798',
    '1319,1523,1524',
  ];

  async discoverFromSearch(keyword: string, page = 1, pageSize = 60): Promise<ProductSku[]> {
    const url = 'https://search.jd.com/Search';
    const params = {
      keyword,
      page: page * 2 - 1,
      s: (page - 1) * pageSize + 1,
      click: 0,
    };

    try {
      const resp = await axios.get(url, {
        params,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 15000,
      });

      const html = resp.data as string;
      const skuMatches = html.match(/data-sku="(\d+)"/g) || [];
      const skus = skuMatches
        .map(m => m.match(/data-sku="(\d+)"/)?.[1])
        .filter((s): s is string => !!s)
        .filter((v, i, a) => a.indexOf(v) === i);

      return skus.map(skuId => ({
        skuId,
        sourceUrl: `https://item.jd.com/${skuId}.html`,
        discoveredAt: new Date().toISOString(),
      }));
    } catch (err) {
      logger.error({ keyword, err }, 'Search discovery failed');
      return [];
    }
  }

  async discoverFromCategory(catId: string, page = 1): Promise<ProductSku[]> {
    const url = `https://list.jd.com/list.html?cat=${catId}&page=${page}&sort=sort_totalsales15_desc&trans=1&JL=6_0_0`;
    
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 15000,
      });

      const html = resp.data as string;
      const matches = html.match(/href="\/\/item\.jd\.com\/(\d+)\.html"/g) || [];
      const skus = matches
        .map(m => m.match(/item\.jd\.com\/(\d+)\.html/)?.[1])
        .filter((s): s is string => !!s)
        .filter((v, i, a) => a.indexOf(v) === i);

      return skus.map(skuId => ({
        skuId,
        sourceUrl: `https://item.jd.com/${skuId}.html`,
        discoveredAt: new Date().toISOString(),
      }));
    } catch (err) {
      logger.error({ catId, err }, 'Category discovery failed');
      return [];
    }
  }

  getCategoryList(): string[] {
    return [...this.knownCategories];
  }
}
