import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimEndpoint, clearEndpoints, endpointsOf, getEndpoint, isPrivateAddress, parseEndpoint, releaseEndpoint, sendUnifiedPush } from './unifiedpush.js';

beforeEach(() => clearEndpoints());

describe('UnifiedPush endpoints are public https addresses', () => {
  it('accepts a distributor’s address', () => {
    assert.equal(parseEndpoint('https://ntfy.example.org/upABC123?up=1'), 'https://ntfy.example.org/upABC123?up=1');
    assert.equal(parseEndpoint('https://8.8.8.8/x'), 'https://8.8.8.8/x');
  });

  it('refuses anything that could reach the gateway’s own network', () => {
    for (const bad of [
      'http://ntfy.example.org/up', 'https://localhost/x', 'https://intranet/x', 'https://host.internal/x', 'https://printer.local/x',
      'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.0.5/x', 'https://172.20.0.1/x', 'https://169.254.169.254/latest',
      'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://user:pw@ntfy.example.org/x', 'not a url', '', 5,
    ]) {
      assert.equal(parseEndpoint(bad), undefined, String(bad));
    }
  });

  it('knows private addresses', () => {
    assert.ok(isPrivateAddress('100.64.0.1'));
    assert.ok(isPrivateAddress('::ffff:127.0.0.1'));
    assert.ok(!isPrivateAddress('1.1.1.1'));
    assert.ok(!isPrivateAddress('2606:4700::1111'));
  });

  it('does not call a name that resolves inside', async () => {
    assert.equal(await sendUnifiedPush('https://localhost.localdomain/x', '{}'), 'failed');
  });
});

describe('endpoints are owned by the account that registered them', () => {
  it('lets the owner refresh and refuses another account', () => {
    assert.equal(claimEndpoint('k', '@a:x', 'https://n.example/1'), 'saved');
    assert.equal(claimEndpoint('k', '@a:x', 'https://n.example/2'), 'saved');
    assert.equal(claimEndpoint('k', '@m:y', 'https://evil.example/1'), 'taken');
    assert.equal(getEndpoint('k')?.endpoint, 'https://n.example/2');
    assert.deepEqual(endpointsOf('@a:x'), [{ pushkey: 'k', endpoint: 'https://n.example/2' }]);
    assert.equal(releaseEndpoint('k', '@m:y'), false);
    assert.equal(releaseEndpoint('k', '@a:x'), true);
  });
});
