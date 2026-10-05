import { useEffect, useState } from 'react';
import type { IPreviewUrlResponse } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { getCached, putCached } from '../deviceCache';

/** How long a preview is kept on the device, and an answer of "no preview". */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const NO_PREVIEW_TTL_MS = 60 * 60 * 1000;

// Keyed by the link alone: the same link appears in several messages, a room opened again draws
// them all again, and a homeserver preview is expensive (it fetches and parses the target page).
// It used to be keyed by the minute, as the sdk does, so going back to a room a minute later asked
// for every preview in it again, and each card popped in late and moved the messages below it.
const previewCache = new Map<string, Promise<IPreviewUrlResponse | null>>();
/** The same, once answered, so a card drawn again is there on the first paint. */
const resolvedPreviews = new Map<string, IPreviewUrlResponse | null>();

function loadPreview(mx: ReturnType<typeof useMatrixClient>, url: string): Promise<IPreviewUrlResponse | null> {
  let cached = previewCache.get(url);
  if (!cached) {
    const key = `preview:${url}`;
    cached = (async () => {
      // Kept from an earlier visit (matrix/deviceCache.ts): no request at all.
      const stored = await getCached<{ preview: IPreviewUrlResponse | null }>(key);
      if (stored) return stored.preview;
      const fresh = await mx.getUrlPreview(url, Math.floor(Date.now() / 60000) * 60000).catch(() => undefined);
      // A failed request isn't kept: it may work next time. "No preview" is, for a while.
      if (fresh !== undefined) void putCached(key, { preview: fresh ?? null }, fresh ? PREVIEW_TTL_MS : NO_PREVIEW_TTL_MS);
      return fresh ?? null;
    })().then((preview) => {
      resolvedPreviews.set(url, preview);
      return preview;
    });
    previewCache.set(url, cached);
  }
  return cached;
}

/**
 * Wraps `mx.getUrlPreview` (MSC-less core Matrix `/media/preview_url` — server-side OpenGraph
 * unfurling, so no client-side CORS/scraping concerns). Resolves to `null` both while loading
 * and when the server has no preview for that link (unsupported site, fetch failure, or a
 * homeserver that doesn't implement the endpoint at all) — callers can't and don't need to tell
 * those apart, since either way the right UI is just "no card".
 */
export function useUrlPreview(url: string | undefined): IPreviewUrlResponse | null {
  const mx = useMatrixClient();
  const [state, setState] = useState<{ url?: string; preview: IPreviewUrlResponse | null }>(() => ({
    url,
    preview: url ? (resolvedPreviews.get(url) ?? null) : null,
  }));

  useEffect(() => {
    if (!url) return undefined;
    if (resolvedPreviews.has(url)) {
      const known = resolvedPreviews.get(url) ?? null;
      setState((prev) => (prev.url === url && prev.preview === known ? prev : { url, preview: known }));
      return undefined;
    }
    let cancelled = false;
    void loadPreview(mx, url).then((preview) => {
      if (!cancelled) setState({ url, preview });
    });
    return () => {
      cancelled = true;
    };
  }, [mx, url]);

  if (!url) return null;
  return state.url === url ? state.preview : (resolvedPreviews.get(url) ?? null);
}
