import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { byNewest, fetchCatalogue, type LiveEntry, type StoryEntry, type WatchVideo } from '../../matrix/videos';

const PAGE = 24;
/** How often an open WATCH page asks for its first page again. */
const REFRESH_MS = 30_000;

const keyOf = (video: Pick<WatchVideo, 'owner' | 'id'>) => `${video.owner}|${video.id}`;

export type CatalogueState = {
  videos: WatchVideo[];
  live: LiveEntry[];
  stories: StoryEntry[];
  hasMore: boolean;
  /** The first page is on its way. */
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Shows an upload or edit at once; the catalogue itself is rebuilt only every minute. */
  pin: (video: WatchVideo) => void;
  /** Hides a deleted video at once, for the same reason. */
  drop: (video: Pick<WatchVideo, 'owner' | 'id'>) => void;
};

/**
 * Pages of the token server's catalogue (matrix/videos.ts), newest first, for a search and a set of
 * channels. `live` and `stories` come with the first page. Your own changes are kept on top of
 * whatever a later page or reload says, since the server's index is up to a minute behind.
 * `enabled` false asks for nothing (the Following tab with nobody followed).
 */
export function useCatalogue({ q = '', owners, enabled = true }: { q?: string; owners?: string[]; enabled?: boolean }): CatalogueState {
  const mx = useMatrixClient();
  const [pages, setPages] = useState<{ videos: WatchVideo[]; next?: string; live: LiveEntry[]; stories: StoryEntry[] }>({ videos: [], live: [], stories: [] });
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [edits, setEdits] = useState<Record<string, WatchVideo | null>>({});
  const [tick, setTick] = useState(0);
  // The owners' contents, not the array's identity.
  const ownersKey = owners ? owners.join('\n') : undefined;
  const latest = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const run = ++latest.current;
    busy.current = false;
    setLoadingMore(false);
    setError(false);
    if (!enabled) {
      setPages({ videos: [], live: [], stories: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchCatalogue(mx, { q, ...(ownersKey !== undefined && { owners: ownersKey ? ownersKey.split('\n') : [] }), limit: PAGE })
      .then((page) => {
        if (run === latest.current) setPages(page);
      })
      .catch(() => {
        if (run === latest.current) {
          setPages({ videos: [], live: [], stories: [] });
          setError(true);
        }
      })
      .finally(() => {
        if (run === latest.current) setLoading(false);
      });
  }, [mx, q, ownersKey, enabled, tick]);

  // The server hands back its old index while it rebuilds one, so the first page is asked for again
  // quietly while the page is open (only before more pages are loaded, which a swap would drop).
  const pagedOn = pages.videos.length > PAGE;
  useEffect(() => {
    if (!enabled || pagedOn) return;
    const timer = window.setInterval(() => {
      if (document.hidden || busy.current) return;
      const run = latest.current;
      fetchCatalogue(mx, { q, ...(ownersKey !== undefined && { owners: ownersKey ? ownersKey.split('\n') : [] }), limit: PAGE })
        .then((page) => {
          if (run === latest.current) setPages(page);
        })
        .catch(() => {});
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mx, q, ownersKey, enabled, pagedOn]);

  const next = pages.next;
  const loadMore = useCallback(() => {
    if (!next || busy.current) return;
    busy.current = true;
    const run = latest.current;
    setLoadingMore(true);
    fetchCatalogue(mx, { q, ...(ownersKey !== undefined && { owners: ownersKey ? ownersKey.split('\n') : [] }), cursor: next, limit: PAGE })
      .then((page) => {
        if (run !== latest.current) return;
        setPages((prev) => ({ ...prev, videos: [...prev.videos, ...page.videos], next: page.next }));
      })
      .catch(() => {
        if (run === latest.current) setError(true);
      })
      .finally(() => {
        busy.current = false;
        if (run === latest.current) setLoadingMore(false);
      });
  }, [mx, q, ownersKey, next]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  const pin = useCallback((video: WatchVideo) => setEdits((prev) => ({ ...prev, [keyOf(video)]: video })), []);
  const drop = useCallback((video: Pick<WatchVideo, 'owner' | 'id'>) => setEdits((prev) => ({ ...prev, [keyOf(video)]: null })), []);

  const videos = useMemo(() => {
    const seen = new Set<string>();
    const out: WatchVideo[] = [];
    for (const video of pages.videos) {
      const key = keyOf(video);
      if (seen.has(key)) continue;
      seen.add(key);
      const edit = edits[key];
      if (edit === null) continue;
      out.push(edit ?? video);
    }
    // An upload the server hasn't indexed yet, when it belongs in this view.
    const wanted = (video: WatchVideo) => {
      if (ownersKey !== undefined && !ownersKey.split('\n').includes(video.owner)) return false;
      const words = q.trim().toLowerCase();
      return !words || `${video.title} ${video.description}`.toLowerCase().includes(words);
    };
    for (const [key, edit] of Object.entries(edits)) if (edit && !seen.has(key) && wanted(edit)) out.push(edit);
    return out.sort(byNewest);
  }, [pages.videos, edits, ownersKey, q]);

  return { videos, live: pages.live, stories: pages.stories, hasMore: !!next, loading, loadingMore, error, loadMore, reload, pin, drop };
}
