export const taobaoSkuFixture = {
  item: {
    title: 'Sanitized multi-dimensional Taobao item',
    images: ['https://img.example.test/item-main.jpg'],
    price: {
      priceMoney: '12.50',
      priceText: '¥12.50',
    },
  },
  seller: {
    shopId: 'shop-fixture',
    shopName: 'Fixture Shop',
    sellerId: 'seller-fixture',
    sellerNick: 'fixture-seller',
    sellerType: 'C',
  },
  skuBase: {
    props: [
      {
        pid: '100',
        name: '颜色',
        values: [
          { vid: '200', name: '黑色', image: 'https://img.example.test/black.jpg' },
          { vid: '201', name: '白色', image: 'https://img.example.test/white.jpg' },
        ],
      },
      {
        pid: '101',
        name: '尺码',
        values: [
          { vid: '300', name: 'M' },
          { vid: '301', name: 'L' },
        ],
      },
      {
        pid: '102',
        name: '材质',
        values: [
          { vid: '400', name: '棉' },
          { vid: '401', name: '麻' },
        ],
      },
    ],
    skus: [
      { skuId: '900001', propPath: '100:200;101:300;102:400', image: 'https://img.example.test/sku-900001.jpg' },
      { skuId: '900002', propPath: '100:201;101:301;102:401' },
      { skuId: '900003', propPath: '100:200;101:301;102:400' },
      { skuId: '900004', propPath: '100:201;101:300;102:401' },
      { skuId: '900005', propPath: '100:200;101:300;102:401' },
    ],
  },
  skuCore: {
    sku2info: {
      '900001': {
        price: { priceMoney: '12.50', priceText: '¥12.50' },
        quantity: 7,
        quantityText: '7件',
      },
      '900002': {
        price: { priceText: '¥19.90' },
        quantity: '3',
        quantityText: '3件',
      },
      '900003': {
        quantity: 0,
        quantityText: '暂时无货',
      },
      '900004': {
        price: { priceMoney: '15.00', priceText: '¥15.00' },
        quantity: 'not-a-number',
      },
      '900005': {},
    },
  },
  apiStack: [
    {
      value: '{"price":{"price":{"priceText":"¥19.90"},"extraPrices":[{"priceText":"¥29.90"}]}}',
    },
  ],
  props: {
    groupProps: [],
  },
  feature: {},
};

export const taobaoNoSkuFixture = {
  item: {
    title: 'Sanitized item without a SKU matrix',
    images: ['https://img.example.test/no-sku-main.jpg'],
    price: {
      priceMoney: '7.25',
      priceText: '¥7.25',
    },
  },
  seller: {
    shopId: 'no-sku-shop',
    shopName: 'No SKU Shop',
    sellerId: 'no-sku-seller',
    sellerNick: 'no-sku-seller',
    sellerType: 'C',
  },
  skuBase: {
    props: [],
    skus: [],
  },
  props: {
    groupProps: [],
  },
  feature: {},
};

const taobao118Skus = Array.from({ length: 118 }, (_, index) => ({
  skuId: String(910000000000 + index),
  propPath: `100:${200 + (index % 2)};101:${300 + (index % 2)};102:${400 + (index % 2)}`,
}));

export const taobao118SkuFixture = {
  ...taobaoSkuFixture,
  item: {
    ...taobaoSkuFixture.item,
    title: 'Sanitized 118-entry SKU fixture',
    price: {
      priceMoney: '10.00',
      priceText: '¥10.00',
    },
  },
  apiStack: [],
  skuBase: {
    ...taobaoSkuFixture.skuBase,
    skus: taobao118Skus,
  },
  skuCore: {
    sku2info: Object.fromEntries(taobao118Skus.map((sku, index) => [
      sku.skuId,
      {
        price: {
          priceMoney: (10 + index / 100).toFixed(2),
          priceText: `¥${(10 + index / 100).toFixed(2)}`,
        },
        quantity: index % 2 === 0 ? 100 - index : String(100 - index),
      },
    ])),
  },
};