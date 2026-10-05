import { useContext, useEffect, useState } from 'react';
import { MatrixClientContext, type useMatrixClient } from '../MatrixClientContext';
import { needsMediaAuthentication } from '../mediaAuth';
import { mediaWorkerReady } from '../mediaWorker';
import { serverThumbnail } from '../thumbnails';
import { publicMediaUrl } from '../publicWeb';

type MediaUrlOptions = {
  width?: number;
  height?: number;
  method?: 'crop' | 'scale';
  /** For a consumer the service worker can't sign for, such as the system's media controls
   *  fetching artwork: always a blob URL where the homeserver wants a token. */
  blob?: boolean;
};

// Same rationale as useAttachmentUrl's cache: the same avatar renders in several places at
// once (server rail, channel list, every message from that sender, member list) and re-renders
// on every revisit/reload — without a cache each of those independently re-fetches. Keyed by
// the fully-resolved HTTP URL (which already encodes size/method) since different requested
// sizes are genuinely different bytes.
const authedMediaUrlCache = new Map<string, Promise<string>>();

// Synchronous record of already-resolved srcs, keyed by the *request* (mxc + size/method) rather
// than the HTTP URL, since the HTTP URL itself is only known after the async auth check. Lets a
// freshly mounted Avatar (e.g. a new message from someone whose avatar is already on screen)
// render the image on its first paint instead of flashing the initial-letter fallback while the
// async resolve re-runs.
const resolvedSrcCache = new WeakMap<ReturnType<typeof useMatrixClient>, Map<string, string>>();

function resolvedKey(mxcUrl: string, width?: number, height?: number, method?: string): string {
  return `${mxcUrl}|${width ?? ''}|${height ?? ''}|${method ?? ''}`;
}

function getResolvedSrc(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string | null | undefined,
  width?: number,
  height?: number,
  method?: string,
): string | null {
  if (!mxcUrl) return null;
  return resolvedSrcCache.get(mx)?.get(resolvedKey(mxcUrl, width, height, method)) ?? null;
}

function setResolvedSrc(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string,
  src: string,
  width?: number,
  height?: number,
  method?: string,
): void {
  let perClient = resolvedSrcCache.get(mx);
  if (!perClient) {
    perClient = new Map();
    resolvedSrcCache.set(mx, perClient);
  }
  perClient.set(resolvedKey(mxcUrl, width, height, method), src);
}

async function resolveAuthenticatedMedia(mx: ReturnType<typeof useMatrixClient>, httpUrl: string): Promise<string> {
  const res = await fetch(httpUrl, { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } });
  if (!res.ok) throw new Error(`Media fetch failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Resolves a plain (unencrypted) `mxc://` URL — avatars, mainly — into something usable in
 * `<img src>`. On homeservers that don't require authenticated media, this is just the plain
 * HTTP URL (cheap: browser-cacheable, no extra fetch). On ones that do, a bare <img> tag can't
 * attach the required Authorization header: the service worker adds it when it can (and caches
 * the file on the device), and otherwise this fetches the bytes itself and hands back a cached
 * blob: URL instead. For message attachments, which may additionally be E2EE-encrypted
 * at the file level, see useAttachmentUrl — that's a different problem (always needs a byte
 * fetch to decrypt) from this hook's "cheap path when possible" one.
 */
export function useMediaUrl(mxcUrl: string | null | undefined, options: MediaUrlOptions = {}): string | null {
  // Signed out there's no client: the public media route serves what a public answer referenced
  // (matrix/publicWeb.ts), and needs no authorisation header.
  const mx = useContext(MatrixClientContext);
  const { blob = false } = options;
  // A thumbnail is asked for at the server's own size it would get anyway (matrix/thumbnails.ts),
  // so every place showing the same picture at about the same size shares one URL, one download
  // and one cached copy; past the largest, the whole file. Without width or height, the whole
  // file — no `method` then either: matrix-js-sdk's mxcUrlToHttp treats a *truthy* resizeMethod
  // alone as a thumbnail request, which would route Avatar.tsx's animated path and EmoteImage.tsx
  // to `/thumbnail` instead of `/download`.
  const askedWidth = options.width ?? options.height;
  const askedHeight = options.height ?? options.width;
  const thumbnail = askedWidth && askedHeight ? serverThumbnail(askedWidth, askedHeight) : undefined;
  const width = thumbnail?.width;
  const height = thumbnail?.height;
  const method = thumbnail?.method;
  // A blob and the media URL itself are kept apart in the resolved-src cache.
  const resolvedAs = blob ? `${method ?? ''}|blob` : method;
  const [src, setSrc] = useState<string | null>(() => (mx ? getResolvedSrc(mx, mxcUrl, width, height, resolvedAs) : null));

  useEffect(() => {
    if (!mxcUrl) {
      setSrc(null);
      return undefined;
    }
    if (!mx) return undefined;

    const known = getResolvedSrc(mx, mxcUrl, width, height, resolvedAs);
    if (known) {
      setSrc(known);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      const useAuth = await needsMediaAuthentication(mx);
      const httpUrl = mx.mxcUrlToHttp(mxcUrl, width, height, method, undefined, undefined, useAuth);
      if (!httpUrl) {
        if (!cancelled) setSrc(null);
        return;
      }

      // The service worker signs it (matrix/mediaWorker.ts) and keeps a copy on the device
      // (public/sw.js), so the next visit, and the next session, loads it from disk.
      if (!useAuth || (!blob && (await mediaWorkerReady()))) {
        setResolvedSrc(mx, mxcUrl, httpUrl, width, height, resolvedAs);
        if (!cancelled) setSrc(httpUrl);
        return;
      }

      let cached = authedMediaUrlCache.get(httpUrl);
      if (!cached) {
        cached = resolveAuthenticatedMedia(mx, httpUrl).catch((err: unknown) => {
          authedMediaUrlCache.delete(httpUrl);
          throw err;
        });
        authedMediaUrlCache.set(httpUrl, cached);
      }

      try {
        const url = await cached;
        setResolvedSrc(mx, mxcUrl, url, width, height, resolvedAs);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();

    return () => {
      cancelled = true;
      // Not revoking — see useAttachmentUrl for the same cached-and-shared-across-mounts tradeoff.
    };
  }, [mx, mxcUrl, width, height, method, blob, resolvedAs]);

  return mx ? src : mxcUrl ? publicMediaUrl(mxcUrl, width, height) : null;
}
