import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { hostOf, isBlockedAddress, urlProblem } from './embedGuard.js';

/** A fetch the guard refused, or that went wrong: the link simply gets no embed. */
export class FetchRefused extends Error {}

export type Fetched = {
  /** Where the content finally came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The response was longer than allowed: `body` is only the start, or nothing at all. */
  truncated: boolean;
};

export type FetchOptions = {
  /** How much of a response of this type to read; 0 refuses that type outright. */
  limitFor: (contentType: string) => number;
  /** Past the limit: keep the start (a page's <head> is near the top) or give up (a file). */
  keepStart?: (contentType: string) => boolean;
  accept?: string;
  timeoutMs?: number;
};

const MAX_REDIRECTS = 5;
const USER_AGENT = `Purrlor link previews (+${process.env.PUBLIC_URL ?? 'https://purrlor.app'})`;

/**
 * Checks every address a name resolves to before the connection is made, and connects only to
 * those: the check and the connection can't disagree, so a name that changes its address between
 * them (DNS rebinding) still can't reach a private one.
 */
export const guardedLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(new FetchRefused(`${hostname} resolves to a private address`));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}) as unknown as LookupFunction;

function proxyFor(url: URL): string | undefined {
  const proxy = (url.protocol === 'https:' ? process.env.HTTPS_PROXY || process.env.https_proxy : undefined) || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return undefined;
  const host = hostOf(url).toLowerCase();
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (noProxy.some((entry) => entry === '*' || host === entry.replace(/^\./, '') || host.endsWith(entry.startsWith('.') ? entry : `.${entry}`))) return undefined;
  return proxy;
}

/** Through a proxy the proxy connects, so the name is checked here just before. */
function checkName(host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    guardedLookup(host, { all: true }, (err: unknown) => (err ? reject(err) : resolve()));
  });
}

function readLimited(stream: AsyncIterable<Uint8Array>, limit: number, keepStart: boolean, abort: () => void): Promise<{ body: Buffer; truncated: boolean }> {
  return (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      if (size + buf.length > limit) {
        if (keepStart) chunks.push(buf.subarray(0, limit - size));
        abort();
        return { body: keepStart ? Buffer.concat(chunks) : Buffer.alloc(0), truncated: true };
      }
      chunks.push(buf);
      size += buf.length;
    }
    return { body: Buffer.concat(chunks), truncated: false };
  })();
}

type Hop = { status: number; location?: string; contentType: string; body: Buffer; truncated: boolean };

function directHop(url: URL, options: FetchOptions, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        // No agent: never the global one, which may hold a proxy or reuse a connection made
        // before this guard looked at it.
        agent: false,
        lookup: guardedLookup,
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: options.accept ?? '*/*', 'Accept-Language': 'en' },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType, body: Buffer.alloc(0), truncated: false });
        }
        const limit = status === 200 ? options.limitFor(contentType) : 0;
        if (limit <= 0) {
          res.destroy();
          return resolve({ status, contentType, body: Buffer.alloc(0), truncated: true });
        }
        readLimited(res, limit, options.keepStart?.(contentType) ?? false, () => res.destroy())
          .then(({ body, truncated }) => resolve({ status, contentType, body, truncated }))
          .catch(reject);
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function proxiedHop(url: URL, options: FetchOptions, signal: AbortSignal): Promise<Hop> {
  await checkName(hostOf(url));
  // Node's fetch goes through the proxy (NODE_USE_ENV_PROXY, docker-compose.yml).
  const res = await fetch(url, {
    redirect: 'manual',
    signal,
    headers: { 'User-Agent': USER_AGENT, Accept: options.accept ?? '*/*', 'Accept-Language': 'en' },
  });
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return { status: res.status, location: res.headers.get('location') ?? undefined, contentType, body: Buffer.alloc(0), truncated: false };
  }
  const limit = res.status === 200 ? options.limitFor(contentType) : 0;
  if (limit <= 0 || !res.body) {
    await res.body?.cancel();
    return { status: res.status, contentType, body: Buffer.alloc(0), truncated: true };
  }
  const reader = res.body as unknown as AsyncIterable<Uint8Array>;
  const { body, truncated } = await readLimited(reader, limit, options.keepStart?.(contentType) ?? false, () => void res.body?.cancel().catch(() => undefined));
  return { status: res.status, contentType, body, truncated };
}

/**
 * GETs a URL people posted, under the guard (embedGuard.ts): every hop's URL and addresses
 * checked, at most MAX_REDIRECTS redirects, a time limit for the whole thing, and no more of the
 * response read than `limitFor` allows its type. Sends no cookies and keeps none.
 */
async function realGuardedGet(raw: string, options: FetchOptions): Promise<Fetched> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = urlProblem(url);
    if (problem) throw new FetchRefused(`${url}: ${problem}`);
    const parsed = new URL(url);
    const result = proxyFor(parsed) ? await proxiedHop(parsed, options, signal) : await directHop(parsed, options, signal);
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = new URL(result.location, parsed).toString();
      continue;
    }
    return { url, status: result.status, contentType: result.contentType, body: result.body, truncated: result.truncated };
  }
  throw new FetchRefused(`${raw}: too many redirects`);
}

let getImpl = realGuardedGet;

export function guardedGet(raw: string, options: FetchOptions): Promise<Fetched> {
  return getImpl(raw, options);
}

/** Tests only: answer every fetch from `fake` instead of the network. Returns the undo. */
export function fakeFetchesForTests(fake: (url: string, options: FetchOptions) => Promise<Fetched>): () => void {
  getImpl = fake;
  return () => {
    getImpl = realGuardedGet;
  };
}

/** JSON from a site's own API, under the same guard; undefined when it isn't there. */
export async function guardedJson(url: string, maxBytes = 512 * 1024): Promise<unknown> {
  const res = await guardedGet(url, { accept: 'application/json', limitFor: (type) => (/json|javascript/.test(type) ? maxBytes : 0) });
  if (res.status !== 200 || res.truncated) return undefined;
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return undefined;
  }
}
