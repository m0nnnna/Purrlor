import { describe, expect, it, vi } from 'vitest';
import { rateLimitWaitMs, withRateLimitRetry } from './rateLimit';

const limited = (retryAfter?: number) => Object.assign(new Error('M_LIMIT_EXCEEDED'), { errcode: 'M_LIMIT_EXCEEDED', data: { retry_after_ms: retryAfter } });

describe('rateLimitWaitMs', () => {
  it('reads the wait the server asks for, capped at a minute, with a default when it gives none', () => {
    expect(rateLimitWaitMs(limited(1500))).toBe(1500);
    expect(rateLimitWaitMs(limited(10 * 60_000))).toBe(60_000);
    expect(rateLimitWaitMs(limited())).toBe(5000);
    expect(rateLimitWaitMs(new Error('M_FORBIDDEN'))).toBeUndefined();
  });
});

describe('withRateLimitRetry', () => {
  it('waits out a rate limit and tries again', async () => {
    const wait = vi.fn(async () => {});
    const write = vi.fn().mockRejectedValueOnce(limited(800)).mockResolvedValueOnce('ok');
    await expect(withRateLimitRetry(write, { wait })).resolves.toBe('ok');
    expect(wait).toHaveBeenCalledWith(800);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('gives up after its retries, and never retries any other error', async () => {
    const wait = vi.fn(async () => {});
    await expect(withRateLimitRetry(() => Promise.reject(limited(1)), { wait, retries: 2 })).rejects.toThrow('M_LIMIT_EXCEEDED');
    expect(wait).toHaveBeenCalledTimes(2);
    const forbidden = vi.fn(() => Promise.reject(new Error('M_FORBIDDEN')));
    await expect(withRateLimitRetry(forbidden, { wait })).rejects.toThrow('M_FORBIDDEN');
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});
