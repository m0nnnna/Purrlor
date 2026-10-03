import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { describeErrors, type ErrorLog, type ErrorSource } from './errorLog.js';
import { describeStats, type StandardMetrics } from './metrics.js';

/**
 * The operator's view of this service (docs/deployment.md, "Errors and metrics"):
 *
 *   GET  /metrics          Prometheus's text format
 *   GET  /stats            what `purrlor metrics` prints
 *   GET  /errors           what `purrlor errors` prints (?source=server|web, ?stack=0)
 *   GET  /errors/recent    "server N\nweb N\nfatal N" over the last ?minutes= (default 15), for the alerts
 *   POST /errors/clear     forget them all
 *
 * Every one needs `Authorization: Bearer <METRICS_TOKEN>`, the PURRLOR_METRICS_TOKEN that `purrlor`
 * keeps in .env. Without a token set, they don't exist (404). The port is reverse-proxied (the push
 * gateway's whole path is), so the token is what keeps them private, not where they're served.
 *
 * Shared with the push gateway: services/push-gateway/src/ops.ts is a copy of this file (checked by
 * its copies.test.ts).
 */

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares in constant time, and by hash so the lengths don't have to match. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  return !!token && !!given && timingSafeEqual(digest(given), digest(token));
}

export type OpsDeps = {
  token: string;
  service: string;
  version?: string;
  metrics: StandardMetrics;
  errors: ErrorLog;
};

export function opsRouter({ token, service, version, metrics, errors }: OpsDeps): Router {
  const router = Router();
  const authorized = (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      res.status(404).end();
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'The metrics token is needed' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  };

  router.get('/metrics', authorized, (_req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.metrics.render());
  });

  router.get('/stats', authorized, (_req, res) => {
    res.type('text/plain; charset=utf-8').send(describeStats(metrics, service, version));
  });

  router.get('/errors', authorized, (req, res) => {
    const source = req.query.source === 'server' || req.query.source === 'web' ? (req.query.source as ErrorSource) : undefined;
    const stackLines = req.query.stack === '0' ? 0 : 6;
    res.type('text/plain; charset=utf-8').send(describeErrors(errors.list(source), service, { stackLines }));
  });

  router.get('/errors/recent', authorized, (req, res) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 15, 1), 24 * 60);
    const counts = errors.countsSince(Date.now() - minutes * 60_000);
    res.type('text/plain; charset=utf-8').send(`server ${counts.server}\nweb ${counts.web}\nfatal ${counts.fatal}\n`);
  });

  router.post('/errors/clear', authorized, (_req, res) => {
    errors.clear();
    res.status(204).end();
  });

  return router;
}

/**
 * The last handler: a request that threw (rather than answering) gets a plain 500, and the error
 * is logged, which records it. Errors that come with their own status under 500 (a malformed JSON
 * body is a 400) are answered with that status and not recorded: they're the caller's mistake.
 */
export function finalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
  if (code >= 500) console.error(`${req.method} ${req.baseUrl}${(req.route as { path?: string } | undefined)?.path ?? ''} failed`, err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(code).json({ error: code >= 500 ? 'Something went wrong' : 'Bad request' });
}
