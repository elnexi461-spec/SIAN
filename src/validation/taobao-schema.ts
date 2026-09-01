import { z } from 'zod';

export const TaobaoDsrScoreSchema = z.object({
  title: z.string(),
  score: z.string(),
  level: z.string(),
  levelText: z.string(),
  type: z.enum(['desc', 'serv', 'post']),
});

export const TaobaoSkuPropSchema = z.object({
  pid: z.string(),
  name: z.string(),
  values: z.array(z.object({
    vid: z.string(),
    name: z.string(),
    image: z.string().optional(),
  })),
});

export const TaobaoSkuSchema = z.object({
  skuId: z.string(),
  properties: z.string(),
  propertiesName: z.string(),
  price: z.number(),
  originalPrice: z.number().optional(),
  stock: z.number().nullable(),
  stockText: z.string().optional(),
  image: z.string().optional(),
});

export const TaobaoReviewSchema = z.object({
  rateId: z.string(),
  buyerNick: z.string(),
  rateContent: z.string(),
  rateDate: z.string(),
  skuInfo: z.string().optional(),
  displayRatePic: z.string().optional(),
  auctionSku: z.string().optional(),
});

export const TaobaoShopInfoSchema = z.object({
  shopId: z.string(),
  shopName: z.string(),
  sellerId: z.string(),
  sellerNick: z.string(),
  sellerType: z.enum(['B', 'C']),
  creditLevel: z.string().optional(),
  creditLevelIcon: z.string().optional(),
  evaluates: z.array(TaobaoDsrScoreSchema).optional(),
  pcShopUrl: z.string().optional(),
  shopIcon: z.string().optional(),
});

export const TaobaoItemDetailSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  images: z.array(z.string()),
  videos: z.array(z.object({
    videoId: z.string(),
    url: z.string(),
    thumbnail: z.string(),
  })).optional(),
  price: z.object({
    priceMoney: z.string(),
    priceText: z.string(),
  }),
  originalPrice: z.object({
    priceMoney: z.string(),
    priceText: z.string(),
  }).optional(),
  vagueSellCount: z.string().optional(),
  category: z.string().optional(),
  shopInfo: TaobaoShopInfoSchema,
  skuBase: z.object({
    props: z.array(TaobaoSkuPropSchema),
    skus: z.array(z.object({
      skuId: z.string(),
      propPath: z.string(),
      image: z.string().optional(),
    })),
  }),
  skuCore: z.record(z.object({
    price: z.object({
      priceMoney: z.string(),
      priceText: z.string(),
    }).optional(),
    quantity: z.number().optional(),
    quantityText: z.string().optional(),
    logisticsTime: z.string().optional(),
  })).optional(),
  props: z.array(z.object({
    name: z.string(),
    value: z.string(),
  })).optional(),
  reviews: z.array(TaobaoReviewSchema).optional(),
  reviewCount: z.number().optional(),
  platform: z.enum(['taobao', 'tmall']),
  itemUrl: z.string(),
});
