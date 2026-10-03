import type { Request, Response } from 'express';
import { clientIp } from './clientIp.js';
import type { ErrorLog } from './errorLog.js';
import { RateLimiter } from './webhooks.js';

/**
 * `POST /api/public/client-errors`: the web app reporting an error it hit in someone's browser
 * (apps/web/src/app/errorReporting.ts), so the operator sees it in `purrlor errors`.
 *
 * Open to anyone, like the rest of /api/public: a signed-out visitor's page can fail too, and the
 * app has no credential it could send that this server checks. So it's treated as untrusted text:
 * only a few known fields are kept, each cut short and scrubbed (errorLog.ts), nothing about who
 * sent it is stored, and it's limited per address and overall so it can't fill the disk or drown
 * the real errors. It always answers 204, so it can't be used to learn anything.
 */
const perAddress = new RateLimiter(10, 10);
// For everyone together: past this, the reports are about one thing anyway.
const overall = new RateLimiter(120, 120);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function clientErrorHandler(errors: ErrorLog) {
  return (req: Request, res: Response): void => {
    res.status(204).end();
    if (!perAddress.take(clientIp(req)) || !overall.take('all')) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = text(body.message);
    if (!message) return;
    errors.record({
      source: 'web',
      message,
      stack: text(body.stack),
      where: text(body.where),
      version: text(body.version),
    });
  };
}
