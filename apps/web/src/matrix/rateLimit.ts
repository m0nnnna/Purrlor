/**
 * Writes that run in the background (the channel-role sync, feed governance) can arrive in a
 * burst — one per channel of every Space you moderate — and a real homeserver answers a burst
 * with `429 M_LIMIT_EXCEEDED` and how long to wait. These wait that long and try again, instead of
 * dropping the write until the next pass.
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Never wait longer than this for one retry, whatever the server asks: the pass runs again later. */
const MAX_WAIT_MS = 60_000;
/** When the server says it's rate limiting but not for how long. */
const DEFAULT_WAIT_MS = 5_000;

/** How long a rate-limit refusal asks us to wait, or undefined when it isn't one. */
export function rateLimitWaitMs(err: unknown): number | undefined {
  const e = err as { errcode?: unknown; httpStatus?: unknown; data?: { retry_after_ms?: unknown } } | null;
  if (!e || (e.errcode !== 'M_LIMIT_EXCEEDED' && e.httpStatus !== 429)) return undefined;
  const asked = e.data?.retry_after_ms;
  return Math.min(typeof asked === 'number' && asked > 0 ? asked : DEFAULT_WAIT_MS, MAX_WAIT_MS);
}

/** Runs `write`, retrying after the wait a rate-limit refusal asks for, up to `retries` times. */
export async function withRateLimitRetry<T>(write: () => Promise<T>, { retries = 3, wait = sleep } = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (err) {
      const ms = rateLimitWaitMs(err);
      if (ms === undefined || attempt >= retries) throw err;
      await wait(ms);
    }
  }
}
