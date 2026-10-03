import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';

export type OpenIdTokenInput = {
  access_token: string;
  matrix_server_name: string;
  /** Seconds until the homeserver stops honoring it, as issued. */
  expires_in?: number;
};

/**
 * Successful validations, remembered briefly. The channel list asks for voice participants every
 * few seconds with the same OpenID token, and each validation is a round trip to the caller's own
 * homeserver — without this, every poll from every open tab would be one. Keyed on a hash of the
 * token plus its server, never the token itself; kept no longer than the token's own lifetime and
 * never past VALIDATION_TTL_MS; bounded, since entries are made by whoever sends requests.
 */
const VALIDATION_TTL_MS = 5 * 60 * 1000;
const MAX_VALIDATIONS = 5000;
const validations = new Map<string, { userId: string; expiresAt: number }>();

function validationKey(input: OpenIdTokenInput): string {
  return createHash('sha256').update(`${input.matrix_server_name}\n${input.access_token}`).digest('hex');
}

/**
 * Where a homeserver's *federation* API actually lives, which is frequently not
 * `https://{server_name}/`. A domain commonly delegates federation to a different host
 * (`matrix.example.com`) so that `example.com` can stay a plain website, and the spec defines an
 * ordered resolution for finding it. Asking `https://{server_name}/_matrix/...` directly — which
 * is all this used to do — works only for the subset of deployments that serve federation from
 * their own apex on 443, and fails with a 404 against a perfectly ordinary delegated setup.
 *
 * Implements the spec's resolution order (steps 3-5 of "Resolving server names"), minus the two
 * literal-IP/explicit-port cases that are handled up front by just using the name as given:
 *
 *  1. `https://{name}/.well-known/matrix/server` → its `m.server` value, used as the host.
 *  2. `_matrix-fed._tcp.{name}` SRV, then the deprecated `_matrix._tcp.{name}`.
 *  3. `{name}:8448`, the default federation port.
 *
 * Note this resolves the *host to connect to*, not a TLS name to validate against — a full
 * federation client also has to keep sending the original server name as `Host` and validate the
 * certificate against the delegated name. Since all this does is a plain HTTPS GET to a public
 * endpoint and reads one field out of the answer, the ordinary TLS validation Node performs
 * against the resolved host is what's wanted here.
 */

/** Resolution costs up to three network round trips, and a token server validates constantly
 *  against the same handful of homeservers. Cached for an hour — long enough to matter, short
 *  enough that moving a homeserver's delegation doesn't need a restart. */
const DELEGATION_TTL_MS = 60 * 60 * 1000;
const delegationCache = new Map<string, { host: string; expiresAt: number }>();

/** A name that already carries an explicit port, or is a literal IP, is used as-is per spec —
 *  no delegation is looked up for either. */
function isExplicitlyAddressed(serverName: string): boolean {
  if (serverName.startsWith('[')) return true; // IPv6 literal, with or without a port
  const parts = serverName.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(serverName);
}

async function fromWellKnown(serverName: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://${serverName}/.well-known/matrix/server`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { 'm.server'?: unknown };
    const target = data['m.server'];
    return typeof target === 'string' && target ? target : undefined;
  } catch {
    return undefined; // No delegation published, or unreachable — fall through to SRV.
  }
}

async function fromSrv(serverName: string): Promise<string | undefined> {
  for (const service of [`_matrix-fed._tcp.${serverName}`, `_matrix._tcp.${serverName}`]) {
    try {
      const records = await dns.resolveSrv(service);
      const best = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      if (best) return `${best.name.replace(/\.$/, '')}:${best.port}`;
    } catch {
      // NXDOMAIN for a server that publishes no SRV is the common case, not an error.
    }
  }
  return undefined;
}

async function resolveFederationHost(serverName: string): Promise<string> {
  if (isExplicitlyAddressed(serverName)) return serverName;

  const cached = delegationCache.get(serverName);
  if (cached && cached.expiresAt > Date.now()) return cached.host;

  const host = (await fromWellKnown(serverName)) ?? (await fromSrv(serverName)) ?? `${serverName}:8448`;
  delegationCache.set(serverName, { host, expiresAt: Date.now() + DELEGATION_TTL_MS });
  return host;
}

/**
 * Validates a Matrix OpenID token by asking the claimed homeserver to confirm it — this is
 * federation's standard "prove who I am to a third party" mechanism, and it works for a user on
 * ANY homeserver federated into the space, not just this deployment's own.
 *
 * Proving *identity* is all this does. Whether that identity may have a token for the room it is
 * asking about is a separate question, answered by `tenancy.ts` and `membership.ts`.
 */
export async function validateOpenIdToken(
  input: OpenIdTokenInput,
  /** This deployment's own homeserver: a token from it is checked there directly, at the address
   *  the service already uses for it, rather than through federation's public address. */
  local?: { serverName: string; baseUrl: string }
): Promise<string> {
  const accessToken = input?.access_token;
  const serverName = input?.matrix_server_name;
  if (!accessToken || !serverName || typeof accessToken !== 'string' || typeof serverName !== 'string') {
    throw new Error('Invalid OpenID token payload');
  }

  const key = validationKey(input);
  const remembered = validations.get(key);
  if (remembered && remembered.expiresAt > Date.now()) return remembered.userId;
  validations.delete(key);

  const base = local && local.baseUrl && serverName === local.serverName ? local.baseUrl.replace(/\/+$/, '') : `https://${await resolveFederationHost(serverName)}`;
  const url = `${base}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OpenID validation failed: ${res.status}`);
  }
  const data = (await res.json()) as { sub?: string };
  if (!data.sub) {
    throw new Error('OpenID validation response missing sub');
  }

  const lifetimeMs = typeof input.expires_in === 'number' && input.expires_in > 0 ? input.expires_in * 1000 : VALIDATION_TTL_MS;
  if (validations.size >= MAX_VALIDATIONS) {
    validations.delete(validations.keys().next().value as string); // insertion order: the oldest
  }
  validations.set(key, { userId: data.sub, expiresAt: Date.now() + Math.min(lifetimeMs, VALIDATION_TTL_MS) });
  return data.sub;
}

/** Test seam: resolution caches for an hour, which would otherwise leak between test cases. */
export function clearFederationDelegationCache(): void {
  delegationCache.clear();
  validations.clear();
}
