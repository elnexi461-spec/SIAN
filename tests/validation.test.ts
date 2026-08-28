import { ResponseValidator } from '../src/validation/validator';
import { ProductNormalizer } from '../src/normalization/normalizer';

describe('ResponseValidator', () => {
  const validator = new ResponseValidator();

  it('validates a correct WareBusiness response', () => {
    const data = {
      skuId: '100012043978',
      shopInfo: { shop: { shopId: '123', shopName: 'Test Shop' } },
      stockInfo: { isStock: true, stockState: 34 },
      price: { p: '99.00', op: '199.00' },
    };
    const result = validator.validateWareBusiness(data);
    expect(result.valid).toBe(true);
    expect(result.data?.skuId).toBe('100012043978');
  });

  it('rejects invalid response', () => {
    const result = validator.validateWareBusiness({ invalid: true });
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

describe('ProductNormalizer', () => {
  const normalizer = new ProductNormalizer();

  it('normalizes price correctly', () => {
    const raw = {
      price: { p: '99.00', op: '199.00', m: '299.00' },
      stockInfo: { isStock: true, stockState: 34 },
    } as any;
    const norm = normalizer.normalize('100012043978', raw);
    expect(norm.skuId).toBe('100012043978');
    expect(norm.price).toBe(99.00);
    expect(norm.originalPrice).toBe(199.00);
    expect(norm.currency).toBe('CNY');
  });
});
