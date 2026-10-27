import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { bearer, newStreamKey, resourceKey, whipRouter, type WhipTarget } from './whip.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('WHIP', () => {
  it('reads keys and resource paths', () => {
    assert.match(newStreamKey(), /^pk_[A-Za-z0-9_-]{43}$/);
    assert.equal(bearer('Bearer pk_abc'), 'pk_abc');
    assert.equal(bearer('Basic x'), undefined);
    assert.equal(resourceKey('/abc/def'), 'abc');
    assert.equal(resourceKey('/abc/../def'), undefined);
  });

  it('passes OBS on to Ingress under the stream’s own key, and points it back here', async () => {
    const seen: { method: string; url: string; auth?: string; body: string }[] = [];
    const ingress = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/sdp', Location: '/w/ingresskey/res1' });
        res.end('answer');
      });
    });
    const target: WhipTarget = {
      base: await listen(ingress),
      ingressKeyFor: (key) => {
        if (key !== 'pk_good') throw Object.assign(new Error('no'), { refusal: true });
        return 'ingresskey';
      },
      refused: (err) => ((err as { refusal?: boolean }).refusal ? { status: 403, code: 'not_live', message: 'Go live first' } : undefined),
    };
    const app = express();
    app.use('/api/public/whip', whipRouter(target, () => false));
    const front = createServer(app);
    const base = await listen(front);
    try {
      const offer = await fetch(`${base}/api/public/whip`, { method: 'POST', headers: { Authorization: 'Bearer pk_good', 'Content-Type': 'application/sdp' }, body: 'offer' });
      assert.equal(offer.status, 201);
      assert.equal(offer.headers.get('location'), '/api/public/whip/ingresskey/res1');
      assert.equal(await offer.text(), 'answer');
      assert.deepEqual(seen[0], { method: 'POST', url: '/w', auth: 'Bearer ingresskey', body: 'offer' });

      assert.equal((await fetch(`${base}/api/public/whip`, { method: 'POST', headers: { Authorization: 'Bearer pk_bad' }, body: 'x' })).status, 403);
      assert.equal((await fetch(`${base}/api/public/whip`, { method: 'POST', body: 'x' })).status, 401);

      assert.equal((await fetch(`${base}/api/public/whip/ingresskey/res1`, { method: 'DELETE' })).status, 200);
      assert.deepEqual(seen[1], { method: 'DELETE', url: '/w/ingresskey/res1', auth: 'Bearer ingresskey', body: '' });
      assert.equal((await fetch(`${base}/api/public/whip/ingresskey/res1`, { method: 'GET' })).status, 404);
    } finally {
      front.close();
      ingress.close();
    }
  });
});
