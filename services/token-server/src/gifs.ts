import { createHash } from 'node:crypto';

/**
 * Klipy (https://klipy.com, docs at https://docs.klipy.com) is the GIF search provider behind
 * `/api/gifs/*`. Its API key is a path segment ("app_key"), not a header — `GET
 * api/v1/{app_key}/gifs/search` and `.../gifs/trending` — so it never touches the browser: every
 * request here is proxied through this server with the key read straight from `KLIPY_API_KEY`.
 *
 * The response this trims down to is deliberately smaller than what Klipy returns (which nests a
 * `file` object keyed by size tier — hd/md/sm/xs — each holding gif/webp/jpg/mp4/webm variants,
 * plus tags and a base64 blur placeholder): the web client only ever needs one preview and one
 * "send this" variant, and forwarding the rest would just be more bytes down the wire for data
 * nothing renders.
 */
const KLIPY_API_BASE = 'https://api.klipy.com/api/v1';
const REQUEST_TIMEOUT_MS = 8000;

export type GifMediaVariant = { url: string; width: number; height: number; size: number };

export type NormalizedGif = {
  id: string;
  title: string;
  preview: { url: string; width: number; height: number };
  /** `gif` always present; `mp4`/`webp` are lighter alternates Klipy may not have for every item. */
  full: { gif: GifMediaVariant; mp4?: GifMediaVariant; webp?: GifMediaVariant };
};

export type GifSearchResult = { results: NormalizedGif[]; nextCursor: string | null };

/** Whether this deployment has a Klipy key configured at all — read live (not cached at import
 *  time) so tests, and an operator restarting with a freshly-set env var, both see it change. */
export function isGifsEnabled(): boolean {
  return !!process.env.KLIPY_API_KEY;
}

/** Klipy's `customer_id` personalizes and rate-limits results per end user — it only needs to be
 *  *stable* per caller, not a real identity, so the Matrix user ID is hashed rather than handed
 *  to a third party as-is. */
function customerIdFor(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** The client's pagination "cursor" is just Klipy's 1-based page number as a string — kept
 *  opaque in the client's type so a future provider that uses a real opaque cursor wouldn't need
 *  a client-side shape change, only this translation. */
function cursorToPage(cursor: unknown): number {
  if (typeof cursor !== 'string' && typeof cursor !== 'number') return 1;
  const n = typeof cursor === 'number' ? cursor : Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
}

type KlipyMediaVariant = { url?: unknown; width?: unknown; height?: unknown; size?: unknown };
type KlipySizeTier = { gif?: KlipyMediaVariant; mp4?: KlipyMediaVariant; webp?: KlipyMediaVariant };
type KlipyItem = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  file?: { hd?: KlipySizeTier; md?: KlipySizeTier; sm?: KlipySizeTier; xs?: KlipySizeTier };
};

function readVariant(v: KlipyMediaVariant | undefined): GifMediaVariant | undefined {
  if (!v || typeof v.url !== 'string' || !v.url) return undefined;
  return {
    url: v.url,
    width: typeof v.width === 'number' ? v.width : 0,
    height: typeof v.height === 'number' ? v.height : 0,
    size: typeof v.size === 'number' ? v.size : 0,
  };
}

/**
 * Turns one raw Klipy GIF object into the client's trimmed shape, or `undefined` if it's missing
 * what the client actually needs (no usable preview or full gif) — a malformed item is dropped
 * from the page of results rather than failing the whole request over one bad entry.
 *
 * Exported for tests, since Klipy's exact field names weren't independently reachable past their
 * docs site's own summarized excerpts — see the Klipy GIFs/Items endpoint example this mirrors
 * (`{ id, slug, title, file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } } }`).
 */
export function normalizeKlipyItem(raw: unknown): NormalizedGif | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as KlipyItem;
  const id =
    typeof item.id === 'number' || typeof item.id === 'string'
      ? String(item.id)
      : typeof item.slug === 'string' && item.slug
        ? item.slug
        : undefined;
  if (!id) return undefined;
  const title = typeof item.title === 'string' ? item.title : '';

  const tiers = item.file;
  if (!tiers) return undefined;

  // Lightest tier available for the search-grid thumbnail; a middling tier for what's actually
  // sent — this is a chat GIF picker, not a full-resolution viewer, so neither end needs `hd`.
  const previewTier = tiers.xs ?? tiers.sm ?? tiers.md ?? tiers.hd;
  const preview = readVariant(previewTier?.gif);
  if (!preview) return undefined;

  const fullTier = tiers.md ?? tiers.sm ?? tiers.hd ?? tiers.xs;
  const fullGif = readVariant(fullTier?.gif);
  if (!fullGif) return undefined;
  const fullMp4 = readVariant(fullTier?.mp4);
  const fullWebp = readVariant(fullTier?.webp);

  return {
    id,
    title,
    preview: { url: preview.url, width: preview.width, height: preview.height },
    full: { gif: fullGif, ...(fullMp4 && { mp4: fullMp4 }), ...(fullWebp && { webp: fullWebp }) },
  };
}

type CacheEntry = { expiresAt: number; value: GifSearchResult };
/** Short — this only exists to absorb the handful of duplicate requests a debounced search box
 *  and React StrictMode/re-render tend to produce, not to serve stale results. */
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): GifSearchResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: GifSearchResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

async function callKlipy(path: 'search' | 'trending', params: Record<string, string>): Promise<GifSearchResult> {
  const appKey = process.env.KLIPY_API_KEY;
  if (!appKey) throw new Error('KLIPY_API_KEY is not set');

  // customer_id is per-user and would otherwise make every distinct caller its own cache entry —
  // fine for correctness, but it defeats the point of a shared short cache for a popular query,
  // so it's left out of the cache key. Nothing in the cached value is user-specific.
  const cacheParams = new URLSearchParams(params);
  cacheParams.delete('customer_id');
  const cacheKey = `${path}?${cacheParams.toString()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(`${KLIPY_API_BASE}/${encodeURIComponent(appKey)}/gifs/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Klipy request failed: ${res.status}`);
  const json = (await res.json()) as {
    result?: boolean;
    data?: { data?: unknown[]; current_page?: number; has_next?: boolean };
  };
  if (!json.result) throw new Error('Klipy request was not successful');

  const items = Array.isArray(json.data?.data) ? json.data.data : [];
  const results = items.map(normalizeKlipyItem).filter((g): g is NormalizedGif => !!g);
  const currentPage = typeof json.data?.current_page === 'number' ? json.data.current_page : cursorToPage(params.page);
  const nextCursor = json.data?.has_next ? String(currentPage + 1) : null;

  const value: GifSearchResult = { results, nextCursor };
  cacheSet(cacheKey, value);
  return value;
}

export async function fetchKlipySearch(opts: {
  query?: unknown;
  cursor?: unknown;
  limit?: unknown;
  locale?: unknown;
  userId: string;
}): Promise<GifSearchResult> {
  const params: Record<string, string> = {
    page: String(cursorToPage(opts.cursor)),
    // Klipy's search requires per_page >= 8.
    per_page: String(clampInt(opts.limit, 8, 50, 24)),
    customer_id: customerIdFor(opts.userId),
    content_filter: 'medium',
    format_filter: 'gif,mp4,webp',
  };
  if (typeof opts.query === 'string' && opts.query.trim()) params.q = opts.query.trim().slice(0, 200);
  if (typeof opts.locale === 'string' && /^[a-zA-Z]{2}$/.test(opts.locale)) params.locale = opts.locale.toLowerCase();
  return callKlipy('search', params);
}

export async function fetchKlipyTrending(opts: {
  cursor?: unknown;
  limit?: unknown;
  locale?: unknown;
  userId: string;
}): Promise<GifSearchResult> {
  const params: Record<string, string> = {
    page: String(cursorToPage(opts.cursor)),
    per_page: String(clampInt(opts.limit, 1, 50, 24)),
    customer_id: customerIdFor(opts.userId),
    content_filter: 'medium',
    format_filter: 'gif,mp4,webp',
  };
  if (typeof opts.locale === 'string' && /^[a-zA-Z]{2}$/.test(opts.locale)) params.locale = opts.locale.toLowerCase();
  return callKlipy('trending', params);
}

/** Test seam: the cache would otherwise leak between test cases. */
export function clearGifCache(): void {
  cache.clear();
}
