/**
 * Per-user token bucket for `/api/gifs/*` — a debounced search box firing on every keystroke plus
 * infinite scroll is normal client behavior, not abuse, so this is generous; it exists to stop a
 * single caller from turning the composer into an unbounded Klipy-quota drain, not to throttle
 * ordinary use. Keyed on the caller's Matrix user ID (known only after `validateOpenIdToken`
 * succeeds), the same trust boundary `openid.ts`'s own validation cache uses.
 */
const CAPACITY = 30;
const REFILL_WINDOW_MS = 60_000; // CAPACITY tokens fully refill over one minute
const MAX_BUCKETS = 5000;

type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();

/** Returns whether the caller had a token to spend (and spends it), refilling first for however
 *  long it's been since it was last touched — no interval timer needed for a bucket this small. */
export function consumeGifRateLimit(key: string, now: number = Date.now()): boolean {
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: CAPACITY, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(CAPACITY, bucket.tokens + (elapsed / REFILL_WINDOW_MS) * CAPACITY);
      bucket.lastRefill = now;
    }
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Test seam. */
export function clearGifRateLimits(): void {
  buckets.clear();
}
