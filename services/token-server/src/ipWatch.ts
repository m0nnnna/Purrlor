import { isIP } from 'node:net';
import { clientIp, type RequestLike } from './clientIp.js';

/** Longest a watch may run, seconds. */
export const MAX_WATCH_SECONDS = 240;

/** One way requests reached the token server: who connected, what they said, what was decided. */
export type SeenAddress = {
  /** The address that opened the connection: the last hop before the token server. */
  peer: string;
  /** The X-Real-IP header, as sent (believed only from a REAL_IP_FROM peer). */
  realIp?: string;
  /** The X-Forwarded-For header, as sent. */
  forwardedFor?: string;
  /** The address the token server settled on (clientIp): what its rate limits count. */
  decided: string;
  requests: number;
  lastSeen: number;
};

const header = (req: RequestLike, name: string) => {
  const value = req.headers[name];
  const first = (Array.isArray(value) ? value[0] : value)?.trim();
  return first ? first.slice(0, 200) : undefined;
};

/**
 * `purrlor ips`: what addresses the token server is actually seeing, for setting up the proxies in
 * front of it. Nothing is recorded unless a watch is running, and then only in memory, for that
 * watch, as one line per distinct combination of hops; the result goes to the admin's terminal and
 * is dropped. Several watches at once share one recording.
 */
export class IpWatch {
  private seen: Map<string, SeenAddress> | undefined;
  private running: Promise<SeenAddress[]> | undefined;
  private until = 0;

  constructor(private readonly realIpFrom?: Set<string>) {}

  /** Called for every request: does nothing unless a watch is running. */
  record(req: RequestLike, now = Date.now()): void {
    if (!this.seen) return;
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || 'unknown';
    const realIp = header(req, 'x-real-ip');
    const forwardedFor = header(req, 'x-forwarded-for');
    const decided = clientIp(req, this.realIpFrom);
    const key = [peer, realIp, forwardedFor, decided].join('\n');
    const entry = this.seen.get(key);
    if (entry) {
      entry.requests += 1;
      entry.lastSeen = now;
    } else if (this.seen.size < 2000) {
      this.seen.set(key, { peer, ...(realIp && { realIp }), ...(forwardedFor && { forwardedFor }), decided, requests: 1, lastSeen: now });
    }
  }

  /** Records for `seconds`, then hands back what was seen (busiest first) and forgets it. */
  watch(seconds: number): Promise<SeenAddress[]> {
    const ms = Math.min(Math.max(Math.round(seconds), 1), MAX_WATCH_SECONDS) * 1000;
    if (this.running) return this.running;
    this.seen = new Map();
    this.until = Date.now() + ms;
    this.running = new Promise((resolve) => {
      setTimeout(() => {
        const result = [...(this.seen?.values() ?? [])].sort((a, b) => b.requests - a.requests);
        this.seen = undefined;
        this.running = undefined;
        resolve(result);
      }, ms);
    });
    return this.running;
  }

  /** When the running watch ends, if one is. */
  endsAt(): number | undefined {
    return this.running ? this.until : undefined;
  }
}

/** The service's one watch, fed by a middleware ahead of every route (server.ts). */
export const ipWatch = new IpWatch();

/** Private, loopback, link-local and carrier-grade NAT ranges: addresses no visitor has. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) === 6) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  return true;
}

/**
 * What the table means, in a sentence or two each: whether the token server sees visitors' own
 * addresses, and if not, which hop is losing them.
 */
export function diagnose(seen: SeenAddress[], realIpFrom: Set<string>): string[] {
  if (seen.length === 0) return ['No requests reached the token server while watching. Open the site (the global feed, a profile) during the watch.'];
  const notes: string[] = [];
  const decided = new Set(seen.map((s) => s.decided));
  const total = seen.reduce((n, s) => n + s.requests, 0);
  const privateDecided = seen.filter((s) => isPrivateAddress(s.decided));
  if (realIpFrom.size === 0) notes.push('REAL_IP_FROM is empty: X-Real-IP is never believed, so addresses come from X-Forwarded-For past private hops.');
  const fromEdge = seen.filter((s) => realIpFrom.has(s.peer));
  if (realIpFrom.size > 0 && fromEdge.length === 0) {
    notes.push(`No request came from REAL_IP_FROM (${[...realIpFrom].join(', ')}): the connections came from ${[...new Set(seen.map((s) => s.peer))].join(', ')}. Point REAL_IP_FROM at the hop that actually connects.`);
  }
  if (fromEdge.some((s) => !s.realIp)) notes.push('Some requests from REAL_IP_FROM had no X-Real-IP header: the edge nginx should set `proxy_set_header X-Real-IP $remote_addr;`.');
  const privateRealIps = [...new Set(fromEdge.map((s) => s.realIp).filter((ip): ip is string => !!ip && isPrivateAddress(ip)))];
  if (privateRealIps.length > 0) {
    notes.push(
      `The edge's X-Real-IP is a private address (${privateRealIps.join(', ')}): the edge itself isn't seeing visitors, only the hop in front of it (a tunnel or proxy that rewrites the source). That hop has to pass the visitor's address on, for example with the PROXY protocol and nginx's \`listen … proxy_protocol\` plus \`set_real_ip_from\`.`
    );
  }
  if (privateDecided.length === seen.length) {
    notes.push(`Every request (${total}) was counted as a private address (${[...decided].join(', ')}), so every visitor shares one rate limit and nothing here knows who is who.`);
  } else if (decided.size === 1 && total > 1) {
    notes.push(`Every request (${total}) was counted as one address, ${[...decided][0]}. If several people or devices were using the site, they're all sharing one rate limit.`);
  } else if (privateDecided.length === 0) {
    notes.push(`Visitors' own public addresses are coming through (${decided.size} distinct).`);
  } else {
    notes.push(`Mixed: ${privateDecided.reduce((n, s) => n + s.requests, 0)} of ${total} requests were counted as a private address.`);
  }
  return notes;
}
