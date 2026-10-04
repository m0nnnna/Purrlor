import type { MatrixClient } from 'matrix-js-sdk';

/** Waits before each retry of a media fetch that failed for a reason that may pass. */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

function serverOf(mxcUrl: string): string {
  return mxcUrl.replace(/^mxc:\/\//, '').split('/')[0] ?? '';
}

/**
 * Whether a failed media request is worth asking again. Another server's media reaches us
 * through our homeserver, which fetches it over federation first: a slow or briefly
 * unreachable server shows up as a timeout (502, 504), a 429, a dropped connection, or for
 * remote media a 404 while the homeserver couldn't get it yet. Our own server's 404 is final.
 */
export function isRetryableMediaFailure(status: number | null, mxcUrl: string, ownServer: string | null): boolean {
  if (status === null) return true; // the request itself failed: offline for a moment, a reset
  if (status === 429 || status >= 500) return true;
  return status === 404 && !!ownServer && serverOf(mxcUrl) !== ownServer;
}

/**
 * Fetches a media URL (download or thumbnail), asking again with growing waits when the failure
 * may pass. Without this a slow server's image stayed a grey box until the page was reloaded.
 */
export async function fetchMedia(
  mx: MatrixClient,
  mxcUrl: string,
  httpUrl: string,
  useAuth: boolean,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let status: number | null = null;
    try {
      const res = await fetch(httpUrl, useAuth ? { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } } : undefined);
      if (res.ok) return res;
      status = res.status;
    } catch {
      status = null;
    }
    const wait = attempt < delays.length ? delays[attempt] : undefined;
    if (wait === undefined || !isRetryableMediaFailure(status, mxcUrl, mx.getDomain())) {
      throw new Error(`Media fetch failed: ${status ?? 'network error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
