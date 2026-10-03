import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * A small metrics registry: counters, gauges and histograms, written out in Prometheus's text
 * format (`GET /metrics`, ops.ts) and as the summary `purrlor metrics` prints. No dependency, since
 * the services need a handful of numbers, not a client library.
 *
 * Shared with the push gateway: services/push-gateway/src/metrics.ts is a copy of this file
 * (checked by its copies.test.ts).
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k].replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

export class Counter {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += by;
    this.values.set(key, entry);
  }
  total(): number {
    let sum = 0;
    for (const { value } of this.values.values()) sum += value;
    return sum;
  }
}

export class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly read: () => number
  ) {}
}

export class Histogram {
  readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[]
  ) {}
  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    // Each bucket counts what's at or under it (cumulative, as Prometheus expects).
    this.buckets.forEach((le, i) => {
      if (value <= le) s.counts[i] += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  /** The bucket bound that `q` of observations fall under: an upper estimate, Infinity past the last. */
  quantile(labels: Labels, q: number): number {
    const s = this.series.get(labelKey(labels));
    if (!s || s.count === 0) return 0;
    const target = q * s.count;
    const i = s.counts.findIndex((n) => n >= target);
    return i === -1 ? Infinity : this.buckets[i];
  }
}

function num(value: number): string {
  if (value === Infinity) return '+Inf';
  if (Number.isNaN(value)) return 'NaN';
  return String(Math.round(value * 1e6) / 1e6);
}

export class Metrics {
  readonly counters: Counter[] = [];
  readonly gauges: Gauge[] = [];
  readonly histograms: Histogram[] = [];

  constructor(readonly prefix: string) {}

  counter(name: string, help: string): Counter {
    const c = new Counter(`${this.prefix}_${name}`, help);
    this.counters.push(c);
    return c;
  }
  gauge(name: string, help: string, read: () => number): Gauge {
    const g = new Gauge(`${this.prefix}_${name}`, help, read);
    this.gauges.push(g);
    return g;
  }
  histogram(name: string, help: string, buckets: number[]): Histogram {
    const h = new Histogram(`${this.prefix}_${name}`, help, buckets);
    this.histograms.push(h);
    return h;
  }

  /** The Prometheus text exposition format, version 0.0.4. */
  render(): string {
    const out: string[] = [];
    const head = (name: string, help: string, type: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const braces = (key: string) => (key ? `{${key}}` : '');
    for (const c of this.counters) {
      head(c.name, c.help, 'counter');
      if (c.values.size === 0) out.push(`${c.name} 0`);
      for (const [key, { value }] of c.values) out.push(`${c.name}${braces(key)} ${num(value)}`);
    }
    for (const g of this.gauges) {
      head(g.name, g.help, 'gauge');
      let value: number;
      try {
        value = g.read();
      } catch {
        value = NaN;
      }
      out.push(`${g.name} ${num(value)}`);
    }
    for (const h of this.histograms) {
      head(h.name, h.help, 'histogram');
      for (const [key, s] of h.series) {
        const sep = key ? `${key},` : '';
        h.buckets.forEach((le, i) => out.push(`${h.name}_bucket{${sep}le="${num(le)}"} ${s.counts[i]}`));
        out.push(`${h.name}_bucket{${sep}le="+Inf"} ${s.count}`);
        out.push(`${h.name}_sum${braces(key)} ${num(s.sum)}`);
        out.push(`${h.name}_count${braces(key)} ${s.count}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** What every service measures about itself: requests, how long they take, the process. */
export function standardMetrics(prefix: string, startedAt = Date.now()) {
  const metrics = new Metrics(prefix);
  const requests = metrics.counter('http_requests_total', 'Requests answered, by route and status class');
  const duration = metrics.histogram('http_request_duration_seconds', 'How long requests took, by route', DURATION_BUCKETS);
  const errors = metrics.counter('errors_total', 'Errors recorded (purrlor errors), by where they happened');

  // How late timers run: a busy or stuck event loop shows here before anything else does.
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let loopP99 = 0;
  const loopTimer = setInterval(() => {
    loopP99 = loop.percentile(99) / 1e9;
    loop.reset();
  }, 60_000);
  loopTimer.unref();

  metrics.gauge('uptime_seconds', 'Seconds since this service started', () => (Date.now() - startedAt) / 1000);
  metrics.gauge('memory_rss_bytes', 'Memory the process holds', () => process.memoryUsage().rss);
  metrics.gauge('memory_heap_used_bytes', 'JavaScript heap in use', () => process.memoryUsage().heapUsed);
  metrics.gauge('event_loop_delay_p99_seconds', 'How late timers ran over the last minute (99th percentile)', () => loopP99);

  /** Express middleware. A route is labelled by its pattern (/api/public/pages/:user), never the
   *  path asked for, so there's one series per route however many pages there are. */
  function measure(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      const label = typeof route === 'string' ? `${req.method} ${req.baseUrl}${route}` : 'other';
      const status = `${Math.floor(res.statusCode / 100)}xx`;
      requests.inc({ route: label, status });
      duration.observe({ route: label }, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  }

  return { metrics, requests, duration, errors, measure };
}

export type StandardMetrics = ReturnType<typeof standardMetrics>;

function bytes(n: number): string {
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`;
}

function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ms(seconds: number): string {
  return seconds === Infinity ? 'over 10 s' : seconds >= 1 ? `${seconds} s` : `${Math.round(seconds * 1000)} ms`;
}

/**
 * What `purrlor metrics` prints: the process, requests by status, the busiest routes with how slow
 * they are, and every other counter and gauge by its description. Counted since the service last
 * started; Prometheus (GET /metrics) is the way to keep history.
 */
export function describeStats(m: StandardMetrics, service: string, version?: string): string {
  const read = (name: string) => m.metrics.gauges.find((g) => g.name === `${m.metrics.prefix}_${name}`)?.read() ?? 0;
  const lines = [
    `${service}${version ? ` (version ${version})` : ''}: up ${duration(read('uptime_seconds'))}, using ${bytes(read('memory_rss_bytes'))} of memory, timers up to ${ms(Math.round(read('event_loop_delay_p99_seconds') * 1000) / 1000)} late`,
  ];

  const byStatus = new Map<string, number>();
  const byRoute = new Map<string, { total: number; failed: number }>();
  for (const { labels, value } of m.requests.values.values()) {
    byStatus.set(labels.status, (byStatus.get(labels.status) ?? 0) + value);
    const r = byRoute.get(labels.route) ?? { total: 0, failed: 0 };
    r.total += value;
    if (labels.status === '5xx') r.failed += value;
    byRoute.set(labels.route, r);
  }
  const total = m.requests.total();
  const statuses = [...byStatus.entries()].sort().map(([s, n]) => `${n} ${s}`);
  lines.push(`  requests since it started: ${total}${statuses.length ? ` (${statuses.join(', ')})` : ''}`);
  const errors = m.errors.total();
  if (errors > 0) lines.push(`  errors recorded since it started: ${errors} (sudo purrlor errors)`);

  const busiest = [...byRoute.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  if (busiest.length) {
    lines.push('  busiest routes (requests, half answered within, 95% within):');
    for (const [route, r] of busiest) {
      const p50 = m.duration.quantile({ route }, 0.5);
      const p95 = m.duration.quantile({ route }, 0.95);
      lines.push(`    ${route}: ${r.total}${r.failed ? `, ${r.failed} failed` : ''} · ${ms(p50)} · ${ms(p95)}`);
    }
  }

  const standard = new Set([m.requests, m.errors] as unknown[]);
  const own = new Set(['uptime_seconds', 'memory_rss_bytes', 'memory_heap_used_bytes', 'event_loop_delay_p99_seconds'].map((n) => `${m.metrics.prefix}_${n}`));
  for (const c of m.metrics.counters) {
    if (standard.has(c)) continue;
    const parts = [...c.values.values()].map(({ labels, value }) => {
      const tag = Object.values(labels).join(' ');
      return tag ? `${value} ${tag}` : `${value}`;
    });
    lines.push(`  ${c.help}: ${parts.length ? parts.join(', ') : 0}`);
  }
  for (const g of m.metrics.gauges) {
    if (own.has(g.name)) continue;
    let value: string;
    try {
      value = String(g.read());
    } catch {
      value = 'unknown';
    }
    lines.push(`  ${g.help}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
