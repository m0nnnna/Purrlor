import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWebhookBody, parseWebhookState, RateLimiter, tokenMatches } from './webhooks.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('webhook tokens', () => {
  it('accepts the token whose hash is stored, and nothing else', () => {
    const stored = sha('s3cret-token');
    assert.equal(tokenMatches('s3cret-token', stored), true);
    assert.equal(tokenMatches('s3cret-tokeN', stored), false);
    assert.equal(tokenMatches('', stored), false);
  });

  it('reads only well-formed webhook state', () => {
    assert.deepEqual(parseWebhookState({ name: 'CI', token_sha256: sha('x'), avatar_url: 'mxc://s/a' }), {
      name: 'CI',
      avatarUrl: 'mxc://s/a',
      tokenSha256: sha('x'),
    });
    // A deleted webhook is empty content; a non-mxc avatar is dropped rather than fetched.
    assert.equal(parseWebhookState({}), undefined);
    assert.equal(parseWebhookState({ name: 'CI', token_sha256: 'not-hex' }), undefined);
    assert.equal(parseWebhookState({ name: 'CI', token_sha256: sha('x'), avatar_url: 'https://evil/a.png' })?.avatarUrl, undefined);
  });
});

describe('parseWebhookBody', () => {
  it('takes Discord’s content and username, or Slack’s text', () => {
    assert.deepEqual(parseWebhookBody({ content: 'Build passed', username: 'CI' }), { text: 'Build passed', username: 'CI' });
    assert.deepEqual(parseWebhookBody({ text: 'Deployed' }), { text: 'Deployed', username: undefined });
  });

  it('refuses empty, missing or oversized messages', () => {
    assert.equal(parseWebhookBody({ content: '   ' }), undefined);
    assert.equal(parseWebhookBody({}), undefined);
    assert.equal(parseWebhookBody(null), undefined);
    assert.equal(parseWebhookBody({ content: 'x'.repeat(4001) }), undefined);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills over time', () => {
    const limiter = new RateLimiter(3, 60);
    const t = 1_000_000;
    assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('hook', t)), [true, true, true, false]);
    // 60 a minute is one a second.
    assert.equal(limiter.take('hook', t + 1000), true);
    assert.equal(limiter.take('hook', t + 1000), false);
    // Other webhooks have their own bucket.
    assert.equal(limiter.take('other', t), true);
  });

  it('forgets the oldest keys rather than growing without bound', () => {
    const limiter = new RateLimiter(1, 1, 2);
    limiter.take('a', 0);
    limiter.take('b', 0);
    limiter.take('c', 0);
    // "a" was forgotten, so it starts with a full bucket again.
    assert.equal(limiter.take('a', 0), true);
  });
});
