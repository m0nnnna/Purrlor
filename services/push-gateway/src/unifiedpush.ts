import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

/**
 * The Android app's notifications: UnifiedPush (https://unifiedpush.org). The phone has a
 * distributor app (ntfy and the like) that gives Purrlor an endpoint URL; a message POSTed to
 * that URL is handed to the app, which wakes it up even when it is closed. This is the other half
 * of subscriptions.ts: pushkey -> endpoint, owned by the account that registered it, so nobody
 * can redirect another person's notifications.
 *
 * The endpoint is an address a client chose and the gateway then calls, so it is held to a
 * public https address (a phone-sized SSRF guard): no credentials, no local or private network
 * addresses, checked again when the name is looked up for a send, and no redirects followed.
 */
type Entry = { endpoint: string; owner: string };
const byPushKey = new Map<string, Entry>();
let file: string | undefined;

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Whether an address (IPv4 or IPv6, as text) is one a public service would never have. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address); // how URL spells it
  const ip = mapped
    ? mapped[1]
    : hex
      ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.')
      : address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('64:ff9b') || ip.startsWith('2001:db8');
  }
  return true; // not an address at all
}

/** An endpoint as a client sent it, or undefined if it isn't a public https URL we would call. */
export function parseEndpoint(value: unknown): string | undefined {
  if (!isText(value, 2048)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateAddress(host) ? undefined : url.href;
  // Names that mean "this machine or this network".
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return undefined;
  return url.href;
}

function save(): void {
  if (!file) return;
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(byPushKey)), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error('Couldn’t save UnifiedPush endpoints', err);
  }
}

export function loadUnifiedPush(path: string | undefined): void {
  file = path;
  byPushKey.clear();
  if (!path) return;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { owner?: unknown; endpoint?: unknown }>;
    for (const [pushkey, entry] of Object.entries(stored)) {
      const endpoint = parseEndpoint(entry?.endpoint);
      if (endpoint && isText(entry?.owner, 255) && isText(pushkey, 512)) byPushKey.set(pushkey, { endpoint, owner: entry.owner });
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.error('Couldn’t read saved UnifiedPush endpoints', err);
  }
}

/** Saves (or refreshes) an endpoint for its owner. `taken` when the pushkey belongs to someone else. */
export function claimEndpoint(pushkey: string, owner: string, endpoint: string): 'saved' | 'taken' {
  const existing = byPushKey.get(pushkey);
  if (existing && existing.owner !== owner) return 'taken';
  byPushKey.set(pushkey, { endpoint, owner });
  if (!existing || existing.endpoint !== endpoint) save();
  return 'saved';
}

export function releaseEndpoint(pushkey: string, owner: string): boolean {
  const existing = byPushKey.get(pushkey);
  if (!existing || existing.owner !== owner) return false;
  byPushKey.delete(pushkey);
  save();
  return true;
}

export function getEndpoint(pushkey: string): Entry | undefined {
  return byPushKey.get(pushkey);
}

/** Every phone an account has registered, where its reminders go. */
export function endpointsOf(owner: string): { pushkey: string; endpoint: string }[] {
  return [...byPushKey].filter(([, e]) => e.owner === owner).map(([pushkey, e]) => ({ pushkey, endpoint: e.endpoint }));
}

export function deleteEndpoint(pushkey: string): void {
  if (byPushKey.delete(pushkey)) save();
}

export function endpointCount(): number {
  return byPushKey.size;
}

export function clearEndpoints(): void {
  byPushKey.clear();
}

/** A DNS lookup that refuses private addresses, so a name pointing inside can't be reached either. */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export function guardedLookup(hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void {
  const all = typeof options === 'object' && !!options?.all;
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const safe = addresses.filter((a) => !isPrivateAddress(a.address));
    if (!safe.length) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: 'EPRIVATE' }), []);
    if (all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

const SEND_TIMEOUT_MS = 10_000;

/** Posts one notification to a phone's endpoint: `gone` when the distributor says it no longer exists. */
export function sendUnifiedPush(endpoint: string, payload: string): Promise<'sent' | 'gone' | 'failed'> {
  return new Promise((resolve) => {
    const req = request(
      endpoint,
      { method: 'POST', lookup: guardedLookup as never, timeout: SEND_TIMEOUT_MS, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), TTL: '86400' } },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve('sent');
        else if (status === 404 || status === 410) resolve('gone');
        else resolve('failed');
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => {
      console.error(`Failed to deliver UnifiedPush to ${new URL(endpoint).host}`, err.message);
      resolve('failed');
    });
    req.end(payload);
  });
}
