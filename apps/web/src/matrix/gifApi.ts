import type { MatrixClient } from 'matrix-js-sdk';
import { getRuntimeConfig } from '../app/runtimeConfig';
import { getOpenIdTokenCached } from './openIdToken';

/**
 * Client for `services/token-server`'s `/api/gifs/*` — GIF search backed by Klipy
 * (https://klipy.com), proxied server-side so the Klipy key never reaches the browser. See
 * `docs/api.md` section 2 for the full request/response shapes this mirrors.
 */

export type GifMediaVariant = { url: string; width: number; height: number; size: number };

export type NormalizedGif = {
  id: string;
  title: string;
  preview: { url: string; width: number; height: number };
  full: { gif: GifMediaVariant; mp4?: GifMediaVariant; webp?: GifMediaVariant };
};

export type GifSearchResult = { results: NormalizedGif[]; nextCursor: string | null };

function gifApiBase(): string | undefined {
  const url = getRuntimeConfig().gifApiUrl;
  return url ? url.replace(/\/+$/, '') : undefined;
}

let capabilitiesPromise: Promise<boolean> | undefined;

/**
 * Whether this deployment actually has GIF search turned on — a Klipy key configured
 * server-side, not just a base URL in this client's own runtime config (a hand-edited `.env`
 * could set one without the other). Cached for the page's lifetime: this only changes with a
 * token-server restart, and every composer instance asking independently would each be a request.
 */
export function areGifsEnabled(): Promise<boolean> {
  const base = gifApiBase();
  if (!base) return Promise.resolve(false);
  if (!capabilitiesPromise) {
    capabilitiesPromise = fetch(`${base}/config`)
      .then((res) => (res.ok ? (res.json() as Promise<{ enabled?: boolean }>) : { enabled: false }))
      .then((data) => !!data.enabled)
      .catch(() => false);
  }
  return capabilitiesPromise;
}

/** Test seam: the capabilities probe would otherwise leak its cached answer between test cases. */
export function clearGifCapabilitiesCache(): void {
  capabilitiesPromise = undefined;
}

async function postGifRequest(
  mx: MatrixClient,
  path: 'search' | 'trending',
  body: Record<string, unknown>
): Promise<GifSearchResult> {
  const base = gifApiBase();
  if (!base) throw new Error('GIF search is not configured on this deployment');

  const openIdToken = await getOpenIdTokenCached(mx);
  const res = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: openIdToken, ...body }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(data?.error ?? `GIF ${path} request failed (${res.status})`);
  }
  return res.json() as Promise<GifSearchResult>;
}

export function searchGifs(
  mx: MatrixClient,
  opts: { query: string; cursor?: string | null; limit?: number; locale?: string }
): Promise<GifSearchResult> {
  return postGifRequest(mx, 'search', {
    query: opts.query,
    ...(opts.cursor && { cursor: opts.cursor }),
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...(opts.locale && { locale: opts.locale }),
  });
}

export function trendingGifs(
  mx: MatrixClient,
  opts: { cursor?: string | null; limit?: number; locale?: string } = {}
): Promise<GifSearchResult> {
  return postGifRequest(mx, 'trending', {
    ...(opts.cursor && { cursor: opts.cursor }),
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...(opts.locale && { locale: opts.locale }),
  });
}

/**
 * Downloads a chosen GIF's "full" variant client-side and hands back a `File` ready for the
 * app's own upload path (`sendFileMessage`) — never a third-party URL sent as the message
 * itself. That's what makes it work in encrypted rooms (the bytes get encrypted like any other
 * attachment) and land on the user's own homeserver rather than depending on Klipy's CDN staying
 * reachable to whoever later reads the message.
 */
export async function downloadGifAsFile(gif: NormalizedGif): Promise<File> {
  const variant = gif.full.gif;
  const res = await fetch(variant.url);
  if (!res.ok) throw new Error(`Failed to download GIF (${res.status})`);
  const blob = await res.blob();
  const safeName = (gif.title || gif.id || 'gif').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
  return new File([blob], `${safeName || 'gif'}.gif`, { type: blob.type || 'image/gif' });
}
