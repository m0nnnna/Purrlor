import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushSubscription } from 'web-push';
import {
  claimSubscription,
  clearSubscriptions,
  deleteSubscription,
  getSubscription,
  loadSubscriptions,
  parseSubscription,
  releaseSubscription,
  subscriptionCount,
} from './subscriptions.js';

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) as PushSubscription;

beforeEach(() => clearSubscriptions());

describe('push subscriptions are owned by the account that registered them', () => {
  it('saves a new pushkey for its owner, and lets the owner refresh it', () => {
    assert.equal(claimSubscription('key1', '@alice:x', sub('https://push/1')), 'saved');
    assert.equal(claimSubscription('key1', '@alice:x', sub('https://push/1b')), 'saved');
    assert.equal(getSubscription('key1')?.subscription.endpoint, 'https://push/1b');
  });

  it("refuses another account's claim on a pushkey, so notifications can't be redirected", () => {
    claimSubscription('key1', '@alice:x', sub('https://push/alice'));
    assert.equal(claimSubscription('key1', '@mallory:y', sub('https://push/mallory')), 'taken');
    assert.equal(getSubscription('key1')?.subscription.endpoint, 'https://push/alice');
    assert.equal(getSubscription('key1')?.owner, '@alice:x');
  });

  it('only lets the owner remove a subscription', () => {
    claimSubscription('key1', '@alice:x', sub('https://push/alice'));
    assert.equal(releaseSubscription('key1', '@mallory:y'), false);
    assert.ok(getSubscription('key1'));
    assert.equal(releaseSubscription('key1', '@alice:x'), true);
    assert.equal(getSubscription('key1'), undefined);
  });

  it('forgets a subscription the push service reports gone, whoever owned it', () => {
    claimSubscription('key1', '@alice:x', sub('https://push/alice'));
    deleteSubscription('key1');
    assert.equal(getSubscription('key1'), undefined);
  });
});

describe('subscriptions survive a restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'purrlor-subs-'));
  });
  afterEach(() => {
    loadSubscriptions(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('are saved as they change and read back on start, owners and all', () => {
    const file = join(dir, 'subscriptions.json');
    loadSubscriptions(file);
    claimSubscription('key1', '@alice:x', sub('https://push/1'));
    claimSubscription('key2', '@bob:x', sub('https://push/2'));
    releaseSubscription('key2', '@bob:x');
    loadSubscriptions(file);
    assert.equal(getSubscription('key1')?.owner, '@alice:x');
    assert.equal(getSubscription('key1')?.subscription.endpoint, 'https://push/1');
    assert.equal(getSubscription('key2'), undefined);
    assert.equal(subscriptionCount(), 1);
  });

  it('skip anything malformed in the file', () => {
    const file = join(dir, 'subscriptions.json');
    writeFileSync(
      file,
      JSON.stringify({
        good: { owner: '@a:x', subscription: sub('https://push/ok') },
        plainHttp: { owner: '@a:x', subscription: sub('http://push/no') },
        noKeys: { owner: '@a:x', subscription: { endpoint: 'https://push/no' } },
        noOwner: { subscription: sub('https://push/no') },
      })
    );
    loadSubscriptions(file);
    assert.deepEqual([getSubscription('good')?.owner, subscriptionCount()], ['@a:x', 1]);
  });

  it('start empty without a file', () => {
    loadSubscriptions(join(dir, 'missing.json'));
    assert.equal(subscriptionCount(), 0);
  });
});

describe('parseSubscription', () => {
  it('keeps an https endpoint and its two keys, and nothing else', () => {
    assert.deepEqual(parseSubscription({ endpoint: 'https://push/1', expirationTime: null, keys: { p256dh: 'p', auth: 'a', extra: 'x' }, junk: 1 }), {
      endpoint: 'https://push/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    assert.equal(parseSubscription({ endpoint: 'http://push/1', keys: { p256dh: 'p', auth: 'a' } }), undefined);
    assert.equal(parseSubscription({ endpoint: 'https://push/1', keys: { p256dh: 'p' } }), undefined);
    assert.equal(parseSubscription({ endpoint: 'https://' + 'x'.repeat(3000), keys: { p256dh: 'p', auth: 'a' } }), undefined);
    assert.equal(parseSubscription(null), undefined);
  });
});
