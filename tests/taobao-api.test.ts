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
import { logger } from '../src/logging';

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