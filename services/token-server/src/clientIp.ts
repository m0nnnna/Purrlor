import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * The visitor's address, for per-address rate limits.
 *
 * Express's `req.ip` (with `trust proxy` set in server.ts) walks X-Forwarded-For back past private
 * hops, which is right for nginx on the same host. It's wrong behind an edge proxy that is itself
 * behind Cloudflare: the edge connects from a private address, so Express trusts it and returns
 * the next hop in X-Forwarded-For, which is Cloudflare's edge server, not the visitor. So every
 * visitor from one Cloudflare location shares a rate limit.
 *
 * REAL_IP_FROM names that edge proxy (comma-separated addresses, like nginx's set_real_ip_from).
 * A request whose connection comes from one of them is taken at its X-Real-IP header, which the
 * edge sets to the visitor's own address. From anywhere else the header is ignored, or anyone
 * could pick their own address by sending it, and `req.ip` is used as before.
 */
export function parseRealIpFrom(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean)
  );
}

export const REAL_IP_FROM = parseRealIpFrom(process.env.REAL_IP_FROM);

export type RequestLike = Pick<Request, 'ip' | 'headers'> & { socket: { remoteAddress?: string } };

export function clientIp(req: RequestLike, realIpFrom: Set<string> = REAL_IP_FROM): string {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (realIpFrom.has(peer)) {
    const header = req.headers['x-real-ip'];
    const realIp = (Array.isArray(header) ? header[0] : header)?.trim();
    if (realIp && isIP(realIp)) return realIp;
  }
  return req.ip ?? (peer || 'unknown');
}
