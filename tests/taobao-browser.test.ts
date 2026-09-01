import { TaobaoBrowserExtractor } from '../src/network/taobao-browser';

describe('Taobao browser session provider', () => {
  it('returns the current browser-context cookies without logging them', async () => {
    const extractor = new TaobaoBrowserExtractor() as any;
    const cookies = [
      { name: '_m_h5_tk', value: 'synthetic-browser-token_1700000000' },
      { name: '_m_h5_tk_enc', value: 'synthetic-browser-encoded' },
      { name: 'sid', value: 'synthetic-browser-session' },
    ];
    const context = {
      cookies: jest.fn().mockResolvedValue(cookies),
    };
    extractor.context = context;

    const provider = extractor.createSessionProvider();
    const cookieHeader = await provider.getCookieHeader();

    expect(cookieHeader).toBe(
      '_m_h5_tk=synthetic-browser-token_1700000000; _m_h5_tk_enc=synthetic-browser-encoded; sid=synthetic-browser-session'
    );
    expect(context.cookies).toHaveBeenCalledWith('https://h5api.m.taobao.com');
  });

  it('refreshes the owned browser page through the provider', async () => {
    const extractor = new TaobaoBrowserExtractor() as any;
    const reload = jest.fn().mockResolvedValue(undefined);
    extractor.page = { reload };

    const provider = extractor.createSessionProvider();
    await provider.refresh();

    expect(reload).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  });
});