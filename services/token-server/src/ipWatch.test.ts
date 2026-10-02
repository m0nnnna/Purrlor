import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, IpWatch, isPrivateAddress, type SeenAddress } from './ipWatch.js';

const EDGE = '192.168.1.7';
const edge = new Set([EDGE]);

const request = (peer: string, headers: Record<string, string> = {}, ip?: string) => ({
  socket: { remoteAddress: peer },
  headers,
  ip: ip ?? peer,
});

describe('IpWatch', () => {
  it('records nothing unless a watch is running', async () => {
    const watch = new IpWatch(edge);
    watch.record(request(EDGE, { 'x-real-ip': '203.0.113.9' }));
    const pending = watch.watch(1);
    watch.record(request(EDGE, { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }));
    watch.record(request(EDGE, { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }));
    watch.record(request('::ffff:172.18.0.5', {}, '172.18.0.5'));
    const seen = await pending;
    assert.deepEqual(
      seen.map(({ peer, realIp, forwardedFor, decided, requests }) => ({ peer, realIp, forwardedFor, decided, requests })),
      [
        { peer: EDGE, realIp: '203.0.113.9', forwardedFor: '203.0.113.9', decided: '203.0.113.9', requests: 2 },
        { peer: '172.18.0.5', realIp: undefined, forwardedFor: undefined, decided: '172.18.0.5', requests: 1 },
      ]
    );
    // And after it ends, nothing again.
    watch.record(request(EDGE, { 'x-real-ip': '203.0.113.10' }));
    assert.deepEqual(await watch.watch(1), []);
  });

  it('shares one recording between watches started together', async () => {
    const watch = new IpWatch(edge);
    const first = watch.watch(1);
    const second = watch.watch(5);
    watch.record(request(EDGE, { 'x-real-ip': '198.51.100.4' }));
    assert.equal(first, second);
    assert.equal((await first).length, 1);
  });
});

describe('isPrivateAddress', () => {
  it('knows the ranges no visitor has', () => {
    for (const ip of ['10.40.40.2', '192.168.1.7', '172.20.0.3', '127.0.0.1', '100.64.1.1', '::1', 'fd00::5', '::ffff:10.0.0.1', 'unknown']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['203.0.113.9', '172.32.0.1', '2001:db8::1', '108.174.48.199']) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe('diagnose', () => {
  const seen = (entries: Partial<SeenAddress>[]): SeenAddress[] =>
    entries.map((e) => ({ peer: EDGE, decided: e.realIp ?? EDGE, requests: 3, lastSeen: 0, ...e }));

  it('says when the edge only sees the tunnel, which hop to fix, and that everyone shares a limit', () => {
    const notes = diagnose(seen([{ realIp: '10.40.40.2', decided: '10.40.40.2' }]), edge).join(' ');
    assert.match(notes, /X-Real-IP is a private address \(10\.40\.40\.2\)/);
    assert.match(notes, /PROXY protocol/);
    assert.match(notes, /Every request \(3\) was counted as a private address/);
  });

  it('says when REAL_IP_FROM names a hop that never connects', () => {
    const notes = diagnose(seen([{ peer: '172.18.0.1', decided: '172.18.0.1' }]), edge).join(' ');
    assert.match(notes, /No request came from REAL_IP_FROM \(192\.168\.1\.7\): the connections came from 172\.18\.0\.1/);
  });

  it('says when the edge sends no X-Real-IP, or REAL_IP_FROM is unset', () => {
    assert.match(diagnose(seen([{ decided: EDGE }]), edge).join(' '), /had no X-Real-IP header/);
    assert.match(diagnose(seen([{ decided: '203.0.113.9' }]), new Set()).join(' '), /REAL_IP_FROM is empty/);
  });

  it('says so when visitors come through as themselves', () => {
    const notes = diagnose(seen([{ realIp: '203.0.113.9' }, { realIp: '198.51.100.4' }]), edge);
    assert.deepEqual(notes, ["Visitors' own public addresses are coming through (2 distinct)."]);
  });

  it('asks for some browsing when nothing came in', () => {
    assert.match(diagnose([], edge)[0], /No requests reached the token server/);
  });
});
