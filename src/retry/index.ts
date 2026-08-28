import { logger } from '../logging';
import { sleep, jitter } from '../utils/helpers';

export enum ErrorCategory {
  RETRYABLE = 'RETRYABLE',
  NON_RETRYABLE = 'NON_RETRYABLE',
  RATE_LIMIT = 'RATE_LIMIT',
  TIMEOUT = 'TIMEOUT',
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export function classifyError(error: unknown): ErrorCategory {
  if (!error) return ErrorCategory.RETRYABLE;

  const message = (error as Error).message || String(error);
  const lower = message.toLowerCase();

  if (lower.includes('econnrefused') || lower.includes('enotfound')) {
    return ErrorCategory.NON_RETRYABLE;
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return ErrorCategory.TIMEOUT;
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return ErrorCategory.RATE_LIMIT;
  }
  if (lower.includes('403') || lower.includes('401') || lower.includes('blocked')) {
    return ErrorCategory.NON_RETRYABLE;
  }

  return ErrorCategory.RETRYABLE;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  context: string = 'operation'
): Promise<{ success: boolean; result?: T; error?: Error; retries: number }> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const result = await fn();
      return { success: true, result, retries: attempt };
    } catch (err) {
      lastError = err as Error;
      const category = classifyError(err);
      
      if (category === ErrorCategory.NON_RETRYABLE || attempt === policy.maxRetries) {
        logger.error({ context, attempt, error: lastError.message }, 'Non-retryable error or max retries exceeded');
        break;
      }

      const delay = jitter(
        Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt)),
        0.3
      );
      
      logger.warn({ context, attempt, delay, category }, 'Retrying after error');
      await sleep(delay);
    }
  }

  return { success: false, error: lastError, retries: policy.maxRetries };
}
