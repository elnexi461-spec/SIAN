import crypto from 'crypto';
import {
  TaobaoApiClient,
  buildMtopDetailRequest,
  classifyMtopResponse,
  extractMtopToken,
  generateMtopSign,
  MtopResponseError,
  parseMtopResponseBody,
} from '../src/network/taobao-api';
import { TaobaoNormalizer } from '../src/normalization/taobao-normalizer';
import { TaobaoBrowserExtractor } from '../src/network/taobao-browser';
import { logger } from '../src/logging';
import {
  taobao118SkuFixture,
  taobaoNoSkuFixture,
  taobaoSkuFixture,
} from './fixtures/taobao-sku-fixture';

const originalTaobaoCookieHeader = process.env.TAOBAO_COOKIE_HEADER;

beforeEach(() => {
  delete process.env.TAOBAO_COOKIE_HEADER;
});

afterEach(() => {
  if (originalTaobaoCookieHeader === undefined) {
    delete process.env.TAOBAO_COOKIE_HEADER;
  } else {
    process.env.TAOBAO_COOKIE_HEADER = originalTaobaoCookieHeader;
  }
});

describe('Taobao MTOP session and signing', () => {
  it('generates the expected lowercase UTF-8 MD5 signature', () => {
    const token = 'abc123';
    const timestamp = '1700000000000';
    const appKey = '12574478';
    const data = '{"itemNumId":"908912749472"}';
    const expected = crypto
      .createHash('md5')
      .update('abc123&1700000000000&12574478&{"itemNumId":"908912749472"}', 'utf8')
      .digest('hex');

    expect(generateMtopSign(token, timestamp, appKey, data)).toBe(expected);
    expect(generateMtopSign(token, timestamp, appKey, data)).toBe('694ecc5752969dcfcfb4fec87f9535a4');
  });

  it('extracts the token portion before the first underscore', () => {
    expect(extractMtopToken('abc123_1700000000')).toBe('abc123');
  });

  it('ignores additional underscores in the cookie value', () => {
    expect(extractMtopToken('abc123_1700000000_more_session_data')).toBe('abc123');
    expect(extractMtopToken('_m_h5_tk=abc123_1700000000_more_session_data; Path=/')).toBe('abc123');
  });

  it('uses the exact serialized data string for both signing and the request parameter', () => {
    const request = buildMtopDetailRequest('908912749472', 'abc123', '1700000000000');
    const expectedData = '{"itemNumId":"908912749472"}';

    expect(request.data).toBe(expectedData);
    expect(request.params.get('data')).toBe(expectedData);
    expect(request.params.get('sign')).toBe(
      generateMtopSign('abc123', '1700000000000', '12574478', expectedData)
    );
  });

  it('uses the exact serialized data string in the real detail request and preserves session cookies', async () => {
    const client = new TaobaoApiClient() as any;
    const get = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'set-cookie': [
            '_m_h5_tk=abc123_1700000000; Path=/',
            '_m_h5_tk_enc=encoded_value; Path=/',
            'sid=session_value; Path=/',
          ],
        },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'set-cookie': [],
        },
        data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
      });
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');
    const signedRequestUrl = get.mock.calls[1][0] as string;
    const signedRequestOptions = get.mock.calls[1][1];
    const params = new URL(signedRequestUrl).searchParams;

    expect(result.success).toBe(true);
    expect(params.get('data')).toBe('{"itemNumId":"908912749472"}');
    expect(params.get('sign')).toBe(
      generateMtopSign('abc123', params.get('t') || '', '12574478', '{"itemNumId":"908912749472"}')
    );
    expect(signedRequestOptions.headers.Cookie).toBe(
      '_m_h5_tk=abc123_1700000000; _m_h5_tk_enc=encoded_value; sid=session_value'
    );
  });

  it('does not expose cookie or token values in errors or retry logs', async () => {
    const client = new TaobaoApiClient() as any;
    const secretToken = 'abc123';
    const secretCookie = '_m_h5_tk=abc123_1700000000; _m_h5_tk_enc=secret_cookie_value';
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    client.session = {
      get: jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          headers: {
            'set-cookie': [
              '_m_h5_tk=abc123_1700000000; Path=/',
              '_m_h5_tk_enc=secret_cookie_value; Path=/',
            ],
          },
          data: '',
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {
            'set-cookie': [],
          },
          data: `someOtherCallback({"ret":["FAIL_SYS_USER_VALIDATE::${secretCookie}"]})`,
        }),
    };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.error).toContain('RISK_CONTROL');
    expect(result.error).not.toContain(secretToken);
    expect(result.error).not.toContain(secretCookie);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretToken);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretCookie);
    logSpy.mockRestore();
  });
});

describe('Taobao MTOP response parsing and classification', () => {
  const successPayload = '{"ret":["SUCCESS::SUCCESS"],"data":{}}';

  it('parses the standard mtopjsonp1 JSONP wrapper', () => {
    const parsed = parseMtopResponseBody(`mtopjsonp1(${successPayload})`);

    expect(parsed.format).toBe('jsonp');
    expect(parsed.callback).toBe('mtopjsonp1');
    expect(parsed.payload.ret).toEqual(['SUCCESS::SUCCESS']);
  });

  it('parses JSONP with a trailing semicolon', () => {
    const parsed = parseMtopResponseBody(`mtopjsonp1(${successPayload});`);

    expect(parsed.payload).toEqual({ ret: ['SUCCESS::SUCCESS'], data: {} });
  });

  it('parses JSONP surrounded by whitespace', () => {
    const parsed = parseMtopResponseBody(` \n  mtopjsonp1( ${successPayload} ) ; \n`);

    expect(parsed.payload.ret).toEqual(['SUCCESS::SUCCESS']);
  });

  it('parses an arbitrary JSONP callback name', () => {
    const parsed = parseMtopResponseBody(`someOtherCallback(${successPayload})`);

    expect(parsed.callback).toBe('someOtherCallback');
    expect(parsed.payload.data).toEqual({});
  });

  it('parses plain JSON', () => {
    const parsed = parseMtopResponseBody(` ${successPayload} `);

    expect(parsed.format).toBe('json');
    expect(parsed.callback).toBeUndefined();
    expect(parsed.payload.ret).toEqual(['SUCCESS::SUCCESS']);
  });

  it('rejects malformed JSON with a structured error', () => {
    try {
      parseMtopResponseBody('someOtherCallback({"ret":["SUCCESS"]');
      throw new Error('Expected malformed JSON to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(MtopResponseError);
      expect((error as MtopResponseError).category).toBe('INVALID_RESPONSE');
      expect((error as Error).message).toContain('invalid JSONP wrapper');
    }

    try {
      parseMtopResponseBody('someOtherCallback({"ret":[SUCCESS]})');
      throw new Error('Expected malformed JSON to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(MtopResponseError);
      expect((error as MtopResponseError).category).toBe('INVALID_RESPONSE');
      expect((error as Error).message).toContain('malformed JSON');
    }
  });

  it('classifies a SUCCESS response from the ret array', () => {
    expect(classifyMtopResponse(parseMtopResponseBody(successPayload).payload)).toBe('SUCCESS');
  });

  it('classifies token-expired responses', () => {
    expect(classifyMtopResponse(parseMtopResponseBody('{"ret":["FAIL_SYS_TOKEN_EXOIRED::token expired"]}').payload))
      .toBe('TOKEN_EXPIRED');
  });

  it('classifies login-required responses', () => {
    expect(classifyMtopResponse(parseMtopResponseBody('{"ret":["LOGIN_REQUIRED::please login"]}').payload))
      .toBe('LOGIN_REQUIRED');
  });

  it('classifies RGV587 risk-control responses', () => {
    expect(classifyMtopResponse(parseMtopResponseBody('{"ret":["RGV587::risk control"]}').payload))
      .toBe('RISK_CONTROL');
  });

  it('classifies item unavailable responses', () => {
    expect(classifyMtopResponse(parseMtopResponseBody('{"ret":["FAIL_BIZ_ITEM_NOT_FOUND::item not found"]}').payload))
      .toBe('ITEM_UNAVAILABLE');
  });

  it('parses and classifies a valid MTOP error body on a non-200 HTTP response', async () => {
    const client = new TaobaoApiClient() as any;
    const get = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'set-cookie': ['_m_h5_tk=abc123_1700000000; Path=/'],
        },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 404,
        headers: {
          'set-cookie': [],
        },
        data: `someOtherCallback({"ret":["FAIL_BIZ_ITEM_NOT_FOUND::item not found"]});`,
      });
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.retries).toBe(0);
    expect(result.error).toContain('ITEM_UNAVAILABLE');
    expect(result.error).toContain('FAIL_BIZ_ITEM_NOT_FOUND::item not found');
  });

  it('never exposes sensitive cookie or token values in classified errors', async () => {
    const client = new TaobaoApiClient() as any;
    const secretToken = 'super-secret-token';
    const secretCookie = `_m_h5_tk=${secretToken}_1700000000; _m_h5_tk_enc=super-secret-encoded`;
    client.session = {
      get: jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          headers: {
            'set-cookie': [
              `_m_h5_tk=${secretToken}_1700000000; Path=/`,
              '_m_h5_tk_enc=super-secret-encoded; Path=/',
            ],
          },
          data: '',
        })
        .mockResolvedValueOnce({
          status: 500,
          headers: {
            'set-cookie': [],
          },
          data: `someOtherCallback({"ret":["FAIL_SYS_USER_VALIDATE::${secretCookie}"]})`,
        }),
    };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.error).toContain('RISK_CONTROL');
    expect(result.error).not.toContain(secretToken);
    expect(result.error).not.toContain(secretCookie);
  });
});

describe('Taobao SKU extraction and normalization', () => {
  const normalizer = new TaobaoNormalizer();

  it('preserves multi-dimensional properties, IDs, prices, stock, and SKU images', () => {
    const client = new TaobaoApiClient() as any;
    const detail = client.parseDetailData('fixture-item', taobaoSkuFixture);
    const normalized = normalizer.normalize('fixture-item', detail);

    expect(detail.skuBase.props.map((prop: any) => prop.name)).toEqual(['颜色', '尺码', '材质']);
    expect(detail.skuBase.props[0].values.map((value: any) => value.name)).toEqual(['黑色', '白色']);
    expect(normalized.skus).toHaveLength(5);
    expect(normalized.skus.map(sku => sku.skuId)).toEqual([
      '900001',
      '900002',
      '900003',
      '900004',
      '900005',
    ]);
    expect(normalized.skus[0].propertiesName).toBe('颜色:黑色;尺码:M;材质:棉');
    expect(normalized.skus[1].propertiesName).toBe('颜色:白色;尺码:L;材质:麻');
    expect(normalized.skus[0].properties).toBe('100:200;101:300;102:400');
    expect(normalized.skus[0].price).toBe(12.5);
    expect(normalized.skus[1].price).toBe(19.9);
    expect(normalized.skus[2].price).toBe(19.9);
    expect(normalized.skus[3].price).toBe(15);
    expect(normalized.skus[4].price).toBe(19.9);
    expect(normalized.originalPrice).toBe(29.9);
    expect(normalized.skus.map(sku => sku.stock)).toEqual([7, 3, 0, null, null]);
    expect(normalized.skus[0].image).toBe('https://img.example.test/sku-900001.jpg');
    expect(normalized.skus[1].image).toBe('https://img.example.test/white.jpg');
  });

  it('does not fabricate a default SKU for a product without a SKU matrix', () => {
    const client = new TaobaoApiClient() as any;
    const detail = client.parseDetailData('no-sku-item', taobaoNoSkuFixture);
    const normalized = normalizer.normalize('no-sku-item', detail);

    expect(detail.skuBase.skus).toEqual([]);
    expect(normalized.skus).toEqual([]);
    expect(normalized.price).toBe(7.25);
  });

  it('keeps all 118 fixture SKU records with their IDs, properties, prices, and stock', () => {
    const client = new TaobaoApiClient() as any;
    const detail = client.parseDetailData('fixture-118-item', taobao118SkuFixture);
    const normalized = normalizer.normalize('fixture-118-item', detail);

    expect(normalized.skus).toHaveLength(118);
    normalized.skus.forEach((sku, index) => {
      const expectedSkuId = String(910000000000 + index);
      const expectedPrice = 10 + index / 100;
      const expectedStock = 100 - index;

      expect(sku.skuId).toBe(expectedSkuId);
      expect(sku.properties).toBe(
        `100:${200 + (index % 2)};101:${300 + (index % 2)};102:${400 + (index % 2)}`
      );
      expect(sku.propertiesName).toMatch(/^颜色:(黑色|白色);尺码:(M|L);材质:(棉|麻)$/);
      expect(sku.price).toBeCloseTo(expectedPrice, 10);
      expect(sku.stock).toBe(expectedStock);
    });
  });
});

describe('Taobao external session cookies', () => {
  const originalCookieHeader = process.env.TAOBAO_COOKIE_HEADER;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCookieHeader === undefined) {
      delete process.env.TAOBAO_COOKIE_HEADER;
    } else {
      process.env.TAOBAO_COOKIE_HEADER = originalCookieHeader;
    }
  });

  it('skips anonymous bootstrap, propagates cookies, and signs with the extracted token', async () => {
    process.env.TAOBAO_COOKIE_HEADER =
      '_m_h5_tk=browser-token_1700000000; _m_h5_tk_enc=browser-encoded; sid=browser-session';
    const get = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': [] },
      data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
    });
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');
    const [requestUrl, requestOptions] = get.mock.calls[0];
    const params = new URL(requestUrl).searchParams;

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(requestOptions.headers.Cookie).toBe(
      '_m_h5_tk=browser-token_1700000000; _m_h5_tk_enc=browser-encoded; sid=browser-session'
    );
    expect(params.get('sign')).toBe(
      generateMtopSign(
        'browser-token',
        params.get('t') || '',
        '12574478',
        '{"itemNumId":"908912749472"}'
      )
    );
  });

  it('ignores malformed cookie segments while preserving values after the first equals sign', async () => {
    process.env.TAOBAO_COOKIE_HEADER =
      'malformed; =discarded; _m_h5_tk=browser-token_1700000000; sid=browser=session=value; trailing';
    const get = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': [] },
      data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
    });
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    await client.fetchItemDetail('908912749472');

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1].headers.Cookie).toBe(
      '_m_h5_tk=browser-token_1700000000; sid=browser=session=value'
    );
  });

  it('returns a safe token-session error without bootstrapping when _m_h5_tk is missing', async () => {
    process.env.TAOBAO_COOKIE_HEADER = 'sid=browser-session; _m_h5_tk_enc=browser-encoded';
    const get = jest.fn();
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    await expect(client.getH5Token('908912749472')).rejects.toThrow(
      'Configured Taobao session is missing a valid _m_h5_tk token'
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves anonymous bootstrap behavior when TAOBAO_COOKIE_HEADER is absent', async () => {
    delete process.env.TAOBAO_COOKIE_HEADER;
    const get = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'set-cookie': ['_m_h5_tk=bootstrap-token_1700000000; Path=/'],
        },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': [] },
        data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
      });
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not bootstrap after an external-session detail failure', async () => {
    process.env.TAOBAO_COOKIE_HEADER = '_m_h5_tk=browser-token_1700000000; sid=browser-session';
    const get = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': [] },
      data: 'mtopjsonp1({"ret":["FAIL_SYS_USER_VALIDATE::risk control"]})',
    });
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(false);
    expect(result.error).toContain('RISK_CONTROL');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('consumes cookies from an injected session provider', async () => {
    delete process.env.TAOBAO_COOKIE_HEADER;
    const provider = {
      getCookieHeader: jest.fn().mockResolvedValue(
        '_m_h5_tk=provider-token_1700000000; _m_h5_tk_enc=provider-encoded; sid=provider-session'
      ),
      refresh: jest.fn(),
    };
    const get = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': [] },
      data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
    });
    const client = new TaobaoApiClient(provider) as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(true);
    expect(provider.getCookieHeader).toHaveBeenCalled();
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(get.mock.calls[0][1].headers.Cookie).toBe(
      '_m_h5_tk=provider-token_1700000000; _m_h5_tk_enc=provider-encoded; sid=provider-session'
    );
  });

  it('refreshes the browser session and retries once after token expiry', async () => {
    delete process.env.TAOBAO_COOKIE_HEADER;
    const provider = {
      getCookieHeader: jest.fn()
        .mockResolvedValueOnce('_m_h5_tk=expired-token_1700000000; _m_h5_tk_enc=expired-encoded')
        .mockResolvedValueOnce('_m_h5_tk=fresh-token_1800000000; _m_h5_tk_enc=fresh-encoded')
        .mockResolvedValueOnce('_m_h5_tk=fresh-token_1800000000; _m_h5_tk_enc=fresh-encoded'),
      refresh: jest.fn().mockResolvedValue(undefined),
    };
    const get = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': [] },
        data: 'mtopjsonp1({"ret":["FAIL_SYS_TOKEN_EXPIRED::token expired"]})',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': [] },
        data: 'mtopjsonp1({"ret":["SUCCESS::SUCCESS"],"data":{}})',
      });
    const client = new TaobaoApiClient(provider) as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.getCookieHeader).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1][1].headers.Cookie).toContain('_m_h5_tk=fresh-token_1800000000');
  });

  it('stops after one provider refresh retry when the refreshed token is still expired', async () => {
    delete process.env.TAOBAO_COOKIE_HEADER;
    const provider = {
      getCookieHeader: jest.fn()
        .mockResolvedValue('_m_h5_tk=expired-token_1700000000; _m_h5_tk_enc=expired-encoded'),
      refresh: jest.fn().mockResolvedValue(undefined),
    };
    const get = jest.fn()
      .mockResolvedValue({
        status: 200,
        headers: { 'set-cookie': [] },
        data: 'mtopjsonp1({"ret":["FAIL_SYS_TOKEN_EXPIRED::token expired"]})',
      });
    const client = new TaobaoApiClient(provider) as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.success).toBe(false);
    expect(result.error).toContain('TOKEN_EXPIRED');
    expect(result.retries).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not expose external cookie or token values in errors or diagnostics', async () => {
    const secretToken = 'synthetic-external-token';
    const secretEncodedCookie = 'synthetic-encoded-cookie';
    const secretCookieHeader =
      `_m_h5_tk=${secretToken}_1700000000; _m_h5_tk_enc=${secretEncodedCookie}; sid=synthetic-session`;
    process.env.TAOBAO_COOKIE_HEADER = secretCookieHeader;
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const get = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': [] },
      data: `mtopjsonp1({"ret":["FAIL_SYS_USER_VALIDATE::_m_h5_tk=${secretToken}_1700000000; _m_h5_tk_enc=${secretEncodedCookie}"]})`,
    });
    const client = new TaobaoApiClient() as any;
    client.session = { get };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.error).toContain('RISK_CONTROL');
    expect(result.error).not.toContain(secretToken);
    expect(result.error).not.toContain(secretEncodedCookie);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretToken);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretEncodedCookie);
  });
});