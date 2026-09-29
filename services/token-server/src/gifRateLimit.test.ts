import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearGifRateLimits, consumeGifRateLimit } from './gifRateLimit.js';

describe('consumeGifRateLimit', () => {
  beforeEach(() => clearGifRateLimits());

  it('allows the first 30 requests in a burst, then blocks', () => {
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      assert.equal(consumeGifRateLimit('@me:example.org', now), true, `request ${i} should be allowed`);
    }
    assert.equal(consumeGifRateLimit('@me:example.org', now), false);
  });

  it('keeps buckets independent per user', () => {
    const now = 2_000_000;
    for (let i = 0; i < 30; i++) consumeGifRateLimit('@a:example.org', now);
    assert.equal(consumeGifRateLimit('@a:example.org', now), false);
    // A different user has their own full bucket.
    assert.equal(consumeGifRateLimit('@b:example.org', now), true);
  });

  it('refills gradually over the one-minute window rather than all at once', () => {
    const start = 3_000_000;
    for (let i = 0; i < 30; i++) consumeGifRateLimit('@me:example.org', start);
    assert.equal(consumeGifRateLimit('@me:example.org', start), false);

    // Half the window has passed: 15 tokens back. Spend all 15, then the 16th is blocked again.
    assert.equal(consumeGifRateLimit('@me:example.org', start + 30_000), true);
    for (let i = 0; i < 14; i++) consumeGifRateLimit('@me:example.org', start + 30_000);
    assert.equal(consumeGifRateLimit('@me:example.org', start + 30_000), false);

    // A full window later, the bucket is back at capacity.
    assert.equal(consumeGifRateLimit('@me:example.org', start + 90_000), true);
  });
});
