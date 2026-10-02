import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OnlineCounter } from './online.js';

describe('OnlineCounter', () => {
  it('counts each account once however often it pings, and forgets it after the window', () => {
    const counter = new OnlineCounter(1000);
    counter.mark('@a:s', 0);
    counter.mark('@a:s', 100);
    counter.mark('@b:s', 500);
    assert.equal(counter.count(600), 2);
    // @a's last ping was at 100: gone at 1100, while @b (500) is still in.
    assert.equal(counter.count(1100), 1);
    assert.equal(counter.count(1500), 0);
  });

  it('keeps someone who pings again in, whoever pinged in between', () => {
    const counter = new OnlineCounter(1000);
    counter.mark('@a:s', 0);
    counter.mark('@b:s', 200);
    counter.mark('@a:s', 900);
    assert.equal(counter.count(1300), 1);
    assert.equal(counter.count(1850), 1);
    assert.equal(counter.count(1950), 0);
  });

  it('holds no account IDs, only keyed hashes', () => {
    const counter = new OnlineCounter(1000);
    counter.mark('@luna:purr.example', 0);
    const stored = [...(counter as unknown as { lastSeen: Map<string, number> }).lastSeen.keys()];
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].includes('luna'));
    // A second counter (a restart) hashes the same account differently.
    const other = new OnlineCounter(1000);
    other.mark('@luna:purr.example', 0);
    assert.notEqual([...(other as unknown as { lastSeen: Map<string, number> }).lastSeen.keys()][0], stored[0]);
  });
});
