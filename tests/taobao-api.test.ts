import crypto from 'crypto';
import { TaobaoApiClient, buildMtopDetailRequest, extractMtopToken, generateMtopSign } from '../src/network/taobao-api';
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
          data: `not-jsonp FAIL_SYS_USER_VALIDATE ${secretCookie}`,
        }),
    };

    const result = await client.fetchItemDetail('908912749472');

    expect(result.error).toBe('BLOCKED: User validation required');
    expect(result.error).not.toContain(secretToken);
    expect(result.error).not.toContain(secretCookie);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretToken);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretCookie);
    logSpy.mockRestore();
  });
});