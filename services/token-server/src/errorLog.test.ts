import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorLog, MAX_GROUPS, describeErrors, fingerprint, fromConsoleArgs, scrub } from './errorLog.js';

describe('scrub', () => {
  it('takes tokens, passwords and keys out', () => {
    const text = scrub(
      'GET /_matrix/media?access_token=syt_abc_123&x=1 failed: Bearer abc.def password=hunter2 mct_Zz9 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      1000
    );
    assert.doesNotMatch(text, /syt_abc|hunter2|abc\.def|mct_Zz9|eyJhbGci/);
    assert.match(text, /access_token=…&x=1/);
  });

  it('takes out what could drive a terminal, and cuts long text short', () => {
    assert.equal(scrub('a\u001b]52;c;x\u0007b‮c', 100), 'a]52;c;xbc');
    assert.equal(scrub('x'.repeat(20), 5), 'xxxxx…');
  });
});

describe('fingerprint', () => {
  it('is the same for one error at different IDs, numbers and line numbers', () => {
    const a = fingerprint({ source: 'web', message: 'No room !abc:purr.example after 3 tries', stack: 'Error\n    at load (https://x/assets/index-1.js:10:5)' });
    const b = fingerprint({ source: 'web', message: 'No room !xyz:other.example after 12 tries', stack: 'Error\n    at load (https://x/assets/index-1.js:99:1)' });
    assert.equal(a, b);
  });

  it('tells apart different places, messages and sources', () => {
    const base = { source: 'web' as const, message: 'Boom', stack: 'Error\n    at a (x.js:1:1)' };
    assert.notEqual(fingerprint(base), fingerprint({ ...base, stack: 'Error\n    at b (x.js:1:1)' }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, message: 'Bang' }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, source: 'server' }));
  });
});

describe('ErrorLog', () => {
  it('groups repeats, counting them, newest first', () => {
    const log = new ErrorLog();
    log.record({ source: 'server', message: 'A' }, 1000);
    log.record({ source: 'web', message: 'B' }, 2000);
    log.record({ source: 'server', message: 'A' }, 3000);
    const [first, second] = log.list();
    assert.equal(first.message, 'A');
    assert.equal(first.count, 2);
    assert.equal(first.first, 1000);
    assert.equal(first.last, 3000);
    assert.equal(second.message, 'B');
    assert.deepEqual(log.list('web').map((g) => g.message), ['B']);
  });

  it('counts recent errors by source, and the ones that stopped the service', () => {
    const log = new ErrorLog();
    log.record({ source: 'server', message: 'old' }, 0);
    log.record({ source: 'server', message: 'A' }, 10_000);
    log.record({ source: 'server', message: 'A' }, 11_000);
    log.record({ source: 'web', message: 'B' }, 12_000);
    log.record({ source: 'server', message: 'Crash: x', fatal: true }, 13_000);
    assert.deepEqual(log.countsSince(5000), { server: 3, web: 1, fatal: 1 });
  });

  it('keeps at most MAX_GROUPS, dropping the one seen longest ago', () => {
    const log = new ErrorLog();
    for (let i = 0; i <= MAX_GROUPS; i++) log.record({ source: 'server', message: `kind ${'x'.repeat(i)}` }, i);
    // The first was seen again, so the second is now the stalest.
    log.record({ source: 'server', message: 'kind ' }, 10_000);
    log.record({ source: 'server', message: 'one more' }, 10_001);
    const messages = log.list().map((g) => g.message);
    assert.equal(messages.length, MAX_GROUPS);
    assert.ok(messages.includes('kind '));
    assert.ok(!messages.includes('kind x'));
  });

  it('tells its hook about each one', () => {
    const seen: string[] = [];
    const log = new ErrorLog(undefined, (r) => seen.push(r.source));
    log.record({ source: 'web', message: 'a' });
    log.record({ source: 'web', message: 'a' });
    assert.deepEqual(seen, ['web', 'web']);
  });

  it('saves a crash right away, and reads it back on start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'purrlor-errors-'));
    try {
      const file = join(dir, 'errors.json');
      const log = new ErrorLog(file);
      log.record({ source: 'server', message: 'Crash: Error: gone', stack: 'Error: gone\n    at x', fatal: true }, 5);
      assert.match(await readFile(file, 'utf8'), /Crash: Error: gone/);
      const again = new ErrorLog(file);
      assert.equal(again.list()[0].message, 'Crash: Error: gone');
      assert.equal(again.list()[0].fatal, true);
      again.clear();
      assert.equal(new ErrorLog(file).list().length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts empty from a file that is missing or not its own', async () => {
    assert.equal(new ErrorLog(join(tmpdir(), 'purrlor-no-such-dir', 'errors.json')).list().length, 0);
  });
});

describe('fromConsoleArgs', () => {
  it('joins the text and takes the first stack', () => {
    const err = new TypeError('bad');
    const { message, stack } = fromConsoleArgs(['Failed to mint token', err, { a: 1 }]);
    assert.equal(message, 'Failed to mint token TypeError: bad {"a":1}');
    assert.equal(stack, err.stack);
  });
});

describe('describeErrors', () => {
  it('says when there are none', () => {
    assert.equal(describeErrors([], 'token server'), 'token server: no errors recorded.\n');
  });

  it('lists each kind with how often, when, where and a few stack lines', () => {
    const log = new ErrorLog();
    const now = 10 * 3600_000;
    const stack = 'TypeError: x is undefined\n  at A (a.js:1:1)\n  at B (b.js:2:2)';
    log.record({ source: 'web', message: 'TypeError: x is undefined', stack, where: '/rooms/:id', version: 'abc1234' }, now - 2 * 3600_000);
    log.record({ source: 'web', message: 'TypeError: x is undefined', stack, where: '/rooms/:id' }, now - 5 * 60_000);
    log.record({ source: 'server', message: 'Crash: boom', fatal: true }, now - 30_000);
    const text = describeErrors(log.list(), 'token server', { now });
    assert.match(text, /^token server: 2 kinds of error, 3 in all/);
    assert.match(text, /\[crashed\] Crash: boom\n {2}once · last 30 s ago · here/);
    assert.match(text, /TypeError: x is undefined\n {2}2 times · last 5 min ago · first 2 h ago · in people's browsers · \/rooms\/:id · version abc1234\n {4}at A \(a\.js:1:1\)\n {4}at B/);
    assert.doesNotMatch(describeErrors(log.list(), 'token server', { now, stackLines: 0 }), /at A/);
  });
});
