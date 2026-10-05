import { isIP } from 'node:net';

/**
 * What the link resolver may fetch (docs/embeds.md, "The fetcher's guard"). The token server
 * fetches pages people post, so a link must never point it at itself, its Docker network or the
 * host's: those answers would come back to whoever posted the link, as an embed.
 */

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Tests only (apps/web/e2e/docker-compose.yml): host names the guard lets through although they're
 * local, so an end-to-end test can embed a page the token server itself serves. Never set in a
 * real deployment.
 */
const TEST_ALLOWED_HOSTS = new Set(
  (process.env.EMBEDS_TEST_ALLOW_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

export function isTestAllowedHost(host: string): boolean {
  return TEST_ALLOWED_HOSTS.has(host.toLowerCase());
}

/** Why a URL can't be fetched, or undefined when it can be (as far as the URL alone says). */
export function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'not http or https';
  if (url.username || url.password) return 'carries a user name or password';
  const host = hostOf(url);
  if (!host) return 'no host';
  if (isTestAllowedHost(host)) return undefined;
  if (!ALLOWED_PORTS.has(url.port)) return `port ${url.port} isn't allowed`;
  // A name with no dot is a local one (Docker's service names: matrix, livekit, token-server).
  if (!isIP(host) && !host.includes('.')) return 'a local name';
  if (/\.(local|localhost|internal|lan|home|arpa)$/i.test(host) || host.toLowerCase() === 'localhost') return 'a local name';
  if (isIP(host) && isBlockedAddress(host)) return 'a private address';
  return undefined;
}

/** The host as an address or a name, without IPv6's brackets. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function ipv4Blocked(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved, broadcast
  );
}

/** Whether an address is one the resolver must never connect to. Anything unparseable is blocked. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(ip) === 4) return ipv4Blocked(ip);
  if (isIP(ip) !== 6) return true;
  const lower = ip.toLowerCase();
  // An IPv4 address carried in IPv6 (::ffff:10.0.0.1, ::10.0.0.1, 64:ff9b::10.0.0.1).
  const embedded = /(?:^::ffff:|^::|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (embedded) return ipv4Blocked(embedded);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    lower === '::' ||
    lower === '::1' ||
    /^f[cd]/.test(lower) || // unique local
    /^fe[89ab]/.test(lower) || // link-local
    /^ff/.test(lower) || // multicast
    /^2001:db8:/.test(lower) || // documentation
    /^(2002|2001:0?):/.test(lower) // 6to4 and Teredo can wrap any IPv4 address
  );
}
