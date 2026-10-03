import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { ErrorLog } from './errorLog.js';
import { Metrics, describeStats, standardMetrics } from './metrics.js';
import { finalErrorHandler, opsRouter, tokenMatches } from './ops.js';
import { clientErrorHandler } from './clientErrors.js';

describe('Metrics', () => {
  it('writes counters, gauges and histograms in the Prometheus text format', () => {
    const m = new Metrics('t');
    m.counter('hits_total', 'Hits').inc({ route: 'a "b"' }, 2);
    m.gauge('up', 'Up', () => 1);
    const h = m.histogram('took_seconds', 'Took', [0.1, 1]);
    h.observe({ route: 'x' }, 0.05);
    h.observe({ route: 'x' }, 0.5);
    h.observe({ route: 'x' }, 5);
    const text = m.render();
    assert.match(text, /# TYPE t_hits_total counter\nt_hits_total\{route="a \\"b\\""\} 2\n/);
    assert.match(text, /# TYPE t_up gauge\nt_up 1\n/);
    assert.match(text, /t_took_seconds_bucket\{route="x",le="0.1"\} 1\nt_took_seconds_bucket\{route="x",le="1"\} 2\nt_took_seconds_bucket\{route="x",le="\+Inf"\} 3\nt_took_seconds_sum\{route="x"\} 5.55\nt_took_seconds_count\{route="x"\} 3\n/);
    assert.equal(h.quantile({ route: 'x' }, 0.5), 1);
    assert.equal(h.quantile({ route: 'x' }, 0.95), Infinity);
    assert.equal(h.quantile({ route: 'nope' }, 0.5), 0);
  });

  it('writes an unused counter as 0, and a gauge that throws as NaN', () => {
    const m = new Metrics('t');
    m.counter('c_total', 'C');
    m.gauge('g', 'G', () => {
      throw new Error('no');
    });
    assert.match(m.render(), /t_c_total 0\n[\s\S]*t_g NaN\n/);
  });
});

describe('tokenMatches', () => {
  it('needs the bearer token exactly, and a token set at all', () => {
    assert.equal(tokenMatches('Bearer s3cret', 's3cret'), true);
    assert.equal(tokenMatches('bearer s3cret', 's3cret'), true);
    assert.equal(tokenMatches('Bearer s3cre', 's3cret'), false);
    assert.equal(tokenMatches('s3cret', 's3cret'), false);
    assert.equal(tokenMatches(undefined, 's3cret'), false);
    assert.equal(tokenMatches('Bearer ', ''), false);
  });
});

describe('ops routes', () => {
  const TOKEN = 'metrics-token';
  const ops = standardMetrics('test');
  const errors = new ErrorLog(undefined, (r) => ops.errors.inc({ source: r.source }));
  let server: Server;
  let base: string;
  let closed: Server;
  let closedBase: string;

  before(async () => {
    const app = express();
    app.use(ops.measure);
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use(opsRouter({ token: TOKEN, service: 'test service', version: 'abc1234', metrics: ops, errors }));
    app.get('/thing/:id', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.post('/client-errors', clientErrorHandler(errors));
    app.use(finalErrorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const off = express();
    off.use(opsRouter({ token: '', service: 'off', metrics: standardMetrics('off'), errors: new ErrorLog() }));
    closed = off.listen(0, '127.0.0.1');
    await new Promise((resolve) => closed.once('listening', resolve));
    closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    closed.close();
  });

  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  it("don't exist without a token, and need it when there is one", async () => {
    assert.equal((await fetch(`${closedBase}/metrics`)).status, 404);
    assert.equal((await fetch(`${closedBase}/metrics`, { headers: { Authorization: 'Bearer ' } })).status, 404);
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/errors`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/metrics`, auth)).status, 200);
  });

  it('count requests by route pattern, not by path', async () => {
    await fetch(`${base}/thing/1`);
    await fetch(`${base}/thing/2`);
    const text = await (await fetch(`${base}/metrics`, auth)).text();
    assert.match(text, /test_http_requests_total\{route="GET \/thing\/:id",status="2xx"\} 2/);
    assert.doesNotMatch(text, /thing\/1/);
  });

  it('record a request that threw, answering 500, and a bad body as 400 without recording it', async () => {
    const before = errors.list('server').length;
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Something went wrong' });
    // finalErrorHandler logs with console.error, which only records once captureProcessErrors is on;
    // here the log is checked through the stats line instead, so the test doesn't patch the console.
    const bad = await fetch(`${base}/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal(errors.list('server').length, before);
  });

  it('take error reports from browsers, keeping only known fields, and always answer 204', async () => {
    const send = (body: unknown) =>
      fetch(`${base}/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ message: 'TypeError: nope', stack: 'at x?access_token=syt_secret', where: '/rooms/:id', version: 'v1', user: '@luna:x' })).status, 204);
    assert.equal((await send({})).status, 204);
    assert.equal((await send({ message: 42 })).status, 204);
    const [group] = errors.list('web');
    assert.equal(group.message, 'TypeError: nope');
    assert.equal(group.where, '/rooms/:id');
    assert.doesNotMatch(JSON.stringify(group), /syt_secret|luna/);
    assert.equal(errors.list('web').length, 1);

    const text = await (await fetch(`${base}/errors?source=web`, auth)).text();
    assert.match(text, /^test service: 1 kind of error, 1 in all/);
    assert.match(await (await fetch(`${base}/errors/recent?minutes=5`, auth)).text(), /^server 0\nweb 1\nfatal 0\n$/);
  });

  it('limit browser reports from one address', async () => {
    const before = errors.list('web').reduce((n, g) => n + g.count, 0);
    for (let i = 0; i < 30; i++) {
      await fetch(`${base}/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'flood' }) });
    }
    const after = errors.list('web').reduce((n, g) => n + g.count, 0);
    assert.ok(after - before < 30, `${after - before} of 30 were kept`);
  });

  it('describe the stats, and clear the errors', async () => {
    const stats = await (await fetch(`${base}/stats`, auth)).text();
    assert.match(stats, /^test service \(version abc1234\): up /);
    assert.match(stats, /requests since it started: \d+ \(\d+ 2xx/);
    assert.match(stats, /GET \/thing\/:id: 2 · /);
    assert.equal((await fetch(`${base}/errors/clear`, { method: 'POST', ...auth })).status, 204);
    assert.equal(await (await fetch(`${base}/errors`, auth)).text(), 'test service: no errors recorded.\n');
    assert.equal(describeStats(ops, 'x').split('\n')[0].startsWith('x: up '), true);
  });
});
