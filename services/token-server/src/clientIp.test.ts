import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, parseRealIpFrom } from './clientIp.js';

const EDGE = parseRealIpFrom('192.168.1.7');

function req(remoteAddress: string, headers: Record<string, string> = {}, ip?: string) {
  return { socket: { remoteAddress }, headers, ip };
}

describe('clientIp', () => {
  it("takes the edge proxy's X-Real-IP, not the Cloudflare hop req.ip would give", () => {
    const fromEdge = req('::ffff:192.168.1.7', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9, 172.68.1.1' }, '172.68.1.1');
    assert.equal(clientIp(fromEdge, EDGE), '203.0.113.9');
    assert.equal(clientIp(req('192.168.1.7', { 'x-real-ip': '2001:db8::5' }), EDGE), '2001:db8::5');
  });

  it('ignores X-Real-IP from anyone else, so nobody can pick their own address', () => {
    assert.equal(clientIp(req('198.51.100.4', { 'x-real-ip': '203.0.113.9' }, '198.51.100.4'), EDGE), '198.51.100.4');
    assert.equal(clientIp(req('192.168.1.8', { 'x-real-ip': '203.0.113.9' }), EDGE), '192.168.1.8');
  });

  it('falls back when the edge sends no usable header, and when no edge is set', () => {
    assert.equal(clientIp(req('192.168.1.7', {}, '192.168.1.7'), EDGE), '192.168.1.7');
    assert.equal(clientIp(req('192.168.1.7', { 'x-real-ip': 'not an address' }, '192.168.1.7'), EDGE), '192.168.1.7');
    assert.equal(clientIp(req('192.168.1.7', { 'x-real-ip': '203.0.113.9' }, '10.0.0.1'), parseRealIpFrom('')), '10.0.0.1');
  });

  it('reads a list of edge addresses', () => {
    assert.deepEqual([...parseRealIpFrom(' 192.168.1.7 , 10.40.40.2,')], ['192.168.1.7', '10.40.40.2']);
  });
});
