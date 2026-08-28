import { withRetry, classifyError, ErrorCategory } from '../src/retry';

describe('Retry Logic', () => {
  it('classifies timeout as retryable', () => {
    expect(classifyError(new Error('ETIMEDOUT'))).toBe(ErrorCategory.TIMEOUT);
  });

  it('classifies 403 as non-retryable', () => {
    expect(classifyError(new Error('403 Forbidden'))).toBe(ErrorCategory.NON_RETRYABLE);
  });

  it('succeeds on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2 });
    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
  });

  it('retries and eventually succeeds', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) throw new Error('temp fail');
      return 'success';
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2 });
    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
  });
});
