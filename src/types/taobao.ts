export interface TaobaoDsrScore {
  title: string;
  score: string;
  level: string;
  levelText: string;
  type: 'desc' | 'serv' | 'post';
}

export interface TaobaoSkuProp {
  pid: string;
  name: string;
  values: Array<{
    vid: string;
    name: string;
    image?: string;
  }>;
}

export interface TaobaoSku {
  skuId: string;
  properties: string; // e.g. "1627207:28341;20509:28314"
  propertiesName: string; // e.g. "颜色分类:黑色;尺码:M"
  price: number;
  originalPrice?: number;
  stock: number | null;
  stockText?: string;
  image?: string;
}

export interface TaobaoReview {
  rateId: string;
  buyerNick: string;
  rateContent: string;
  rateDate: string;
  skuInfo?: string; // purchased variant, e.g. "颜色分类:黑色;尺码:M"
  displayRatePic?: string;
  auctionSku?: string;
}

export interface TaobaoShopInfo {
  shopId: string;
  shopName: string;
  sellerId: string;
  sellerNick: string;
  sellerType: 'B' | 'C'; // B = Tmall, C = Taobao
  creditLevel?: string;
  creditLevelIcon?: string;
  evaluates?: TaobaoDsrScore[];
  pcShopUrl?: string;
  shopIcon?: string;
}

export interface TaobaoItemDetail {
  itemId: string;
  title: string;
  images: string[];
  videos?: Array<{
    videoId: string;
    url: string;
    thumbnail: string;
  }>;
  price: {
    priceMoney: string;
    priceText: string;
  };
  originalPrice?: {
    priceMoney: string;
    priceText: string;
  };
  vagueSellCount?: string;
  category?: string;
  shopInfo: TaobaoShopInfo;
  skuBase: {
    props: TaobaoSkuProp[];
    skus: Array<{
      skuId: string;
      propPath: string;
      image?: string;
    }>;
  };
  skuCore?: Record<string, {
    price?: { priceMoney: string; priceText: string };
    quantity?: number;
    quantityText?: string;
    logisticsTime?: string;
  }>;
  props?: Array<{
    name: string;
    value: string;
  }>;
  reviews?: TaobaoReview[];
  reviewCount?: number;
  platform: 'taobao' | 'tmall';
  itemUrl: string;
}

export interface TaobaoNormalizedProduct {
  skuId: string;
  itemId: string;
  platform: 'taobao' | 'tmall';
  title?: string;
  price?: number;
  originalPrice?: number;
  currency: string;
  brand?: string;
  category?: string;
  stockStatus?: string;
  shopId?: string;
  shopName?: string;
  shopType?: 'tmall' | 'taobao';
  shopScore?: number;
  goodRate?: string; // may be unavailable
  dsrScores?: {
    description: number;
    service: number;
    logistics: number;
  };
  specifications: Record<string, string>;
  skus: TaobaoSku[];
  reviews: TaobaoReview[];
  reviewCount?: number;
  images: string[];
  itemUrl: string;
  scrapedAt: string;
}
