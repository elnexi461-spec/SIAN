import { z } from 'zod';

export const WareBusinessResponseSchema = z.object({
  skuId: z.string().optional(),
  shopInfo: z.object({
    shop: z.object({
      shopId: z.string().optional(),
      shopName: z.string().optional(),
      shopUrl: z.string().optional(),
    }).optional(),
    venderId: z.string().optional(),
  }).optional(),
  stockInfo: z.object({
    isStock: z.boolean().optional(),
    stockCount: z.number().optional(),
    stockState: z.number().optional(),
    areaStock: z.boolean().optional(),
  }).optional(),
  price: z.object({
    p: z.string().optional(),
    op: z.string().optional(),
    m: z.string().optional(),
    id: z.string().optional(),
  }).optional(),
  YuShouInfo: z.record(z.unknown()).optional(),
  miaoshaInfo: z.record(z.unknown()).optional(),
  brandInfo: z.object({
    name: z.string().optional(),
    id: z.string().optional(),
  }).optional(),
  categoryInfo: z.record(z.unknown()).optional(),
  wareInfo: z.record(z.unknown()).optional(),
}).passthrough().refine(
  data => ['skuId', 'shopInfo', 'stockInfo', 'price', 'brandInfo', 'categoryInfo', 'wareInfo']
    .some(key => key in data),
  { message: 'Response does not contain recognized WAREBUSINESS fields' }
);

export const NormalizedProductSchema = z.object({
  skuId: z.string(),
  title: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  price: z.number().optional(),
  originalPrice: z.number().optional(),
  currency: z.string().default('CNY'),
  stockStatus: z.string().optional(),
  shopId: z.string().optional(),
  shopName: z.string().optional(),
  isJdSelfRun: z.boolean().optional(),
  imageUrl: z.string().optional(),
  productUrl: z.string(),
  scrapedAt: z.string(),
});

export type ValidatedWareBusiness = z.infer<typeof WareBusinessResponseSchema>;
export type ValidatedNormalizedProduct = z.infer<typeof NormalizedProductSchema>;
