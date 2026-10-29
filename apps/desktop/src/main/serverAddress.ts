/**
 * The Purrlor server the desktop app opens: the address of a Purrlor web client deployment
 * (e.g. https://purr.meowops.net), not a Matrix homeserver. Whether that deployment is locked to
 * one homeserver or lets people pick is up to it (its /config.json); the desktop app only picks
 * which deployment to load.
 */
export const DEFAULT_SERVER = 'https://purr.meowops.net/';

export type Normalized = { ok: true; origin: string } | { ok: false; error: string };

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * Turns what someone typed ("purr.example.com", "https://purr.example.com/login") into the origin
 * to load. Purrlor is always served from the root of its origin (it fetches /config.json and
 * registers /sw.js), so any path is dropped.
 */
export function normalizeServer(input: string | null | undefined): Normalized {
  let text = (input ?? '').trim();
  if (!text) return { ok: false, error: 'Enter a server address.' };
  if (!text.includes('://')) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That isn’t a valid address.' };
  }
  if (!url.hostname) return { ok: false, error: 'That isn’t a valid address.' };
  if (url.username || url.password) return { ok: false, error: 'The address can’t contain a username or password.' };
  // Voice, notifications and encryption all need a secure context.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname))) {
    return { ok: false, error: 'The server must use https://.' };
  }
  return { ok: true, origin: `${url.origin}/` };
}

export function isSameOrigin(candidate: string | null | undefined, server: string): boolean {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === new URL(server).origin;
  } catch {
    return false;
  }
}

export function displayName(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/**
 * Every Purrlor web deployment serves /config.json (apps/web/deploy/40-purrlor-config.sh), so
 * reading it back as a JSON object is a cheap check that the address is right. Null means fine.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function probeServer(origin: string, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetcher(new URL('config.json', origin).toString(), { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return 'That server doesn’t look like Purrlor (it has no config.json).';
    }
    return body && typeof body === 'object' && !Array.isArray(body) ? null : 'The server didn’t return a Purrlor config.';
  } catch (err) {
    if (controller.signal.aborted) return 'The server didn’t answer in time.';
    return `Couldn’t reach the server: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}
