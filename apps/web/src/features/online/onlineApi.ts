import { atom } from 'jotai';
import type { MatrixClient } from 'matrix-js-sdk';
import { isDemoMode } from '../../demo/demoMode';
import { getOpenIdTokenCached } from '../../matrix/openIdToken';

/** How many people have the app open, as the token server last said; null until it has. */
export const onlineCountAtom = atom<number | null>(null);

const ONLINE_API = '/api/public/online';

function readCount(value: unknown): number | undefined {
  const online = (value as { online?: unknown } | null)?.online;
  return typeof online === 'number' && Number.isInteger(online) && online >= 0 ? online : undefined;
}

/**
 * Tells the token server this account has the app open, and hands back the count. The token server
 * keeps only a keyed hash of the account and when it last pinged, in memory, for a few minutes
 * (services/token-server/src/online.ts): enough to count, nothing to say who. Undefined when there's
 * no public web on this deployment, or it didn't answer.
 */
export async function pingOnline(mx: MatrixClient): Promise<number | undefined> {
  if (isDemoMode()) return undefined;
  try {
    const response = await fetch(ONLINE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openid_token: await getOpenIdTokenCached(mx) }),
    });
    return response.ok ? readCount(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** The count alone, for someone who isn't signed in. */
export async function fetchOnline(): Promise<number | undefined> {
  if (isDemoMode()) return undefined;
  try {
    const response = await fetch(ONLINE_API);
    return response.ok ? readCount(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}
