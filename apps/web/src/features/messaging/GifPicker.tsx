import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { areGifsEnabled, downloadGifAsFile, searchGifs, trendingGifs, type NormalizedGif } from '../../matrix/gifApi';
import './GifPicker.css';

const SEARCH_DEBOUNCE_MS = 350;
const PAGE_LIMIT = 24;
/** How close to the bottom of the scrollable grid triggers the next page. */
const LOAD_MORE_THRESHOLD_PX = 200;

/**
 * The composer's GIF button, next to `EmojiAndEmotePicker` — trending on open, a debounced search
 * box, and infinite scroll, backed by `services/token-server`'s Klipy proxy (`../../matrix/gifApi`,
 * see `docs/api.md` section 2). Renders nothing at all when this deployment has no GIF search
 * configured, rather than a button that would just show an error on click.
 *
 * Picking a GIF downloads it client-side (`downloadGifAsFile`) and hands the resulting `File` to
 * the caller, which sends it exactly like any other composer attachment (`sendFileMessage`) — the
 * same reason `EmojiAndEmotePicker`'s sticker tab leaves the actual `sendStickerMessage` call to
 * `Composer` rather than doing it here.
 */
export function GifPicker({ onPickGif }: { onPickGif: (file: File) => void }) {
  const mx = useMatrixClient();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<NormalizedGif[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [sendingId, setSendingId] = useState<string>();
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const cursorRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    areGifsEnabled().then((result) => {
      if (!cancelled) setEnabled(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const runQuery = (q: string, append: boolean) => {
    const requestId = ++requestIdRef.current;
    (append ? setLoadingMore : setLoading)(true);
    setError(undefined);
    const locale = typeof navigator !== 'undefined' ? navigator.language?.split(/[-_]/)[0] : undefined;
    const request = q.trim()
      ? searchGifs(mx, { query: q.trim(), cursor: append ? cursorRef.current : undefined, limit: PAGE_LIMIT, locale })
      : trendingGifs(mx, { cursor: append ? cursorRef.current : undefined, limit: PAGE_LIMIT, locale });

    request
      .then((result) => {
        if (requestId !== requestIdRef.current) return; // superseded by a newer query
        setGifs((prev) => (append ? [...prev, ...result.results] : result.results));
        setCursor(result.nextCursor);
        cursorRef.current = result.nextCursor;
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load GIFs');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      });
  };

  // Trending on open, every time — the panel always starts blank rather than resuming whatever
  // was typed the last time it was open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setGifs([]);
    setCursor(null);
    cursorRef.current = null;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    runQuery('', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setGifs([]);
      setCursor(null);
      cursorRef.current = null;
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      runQuery(value, false);
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el || loading || loadingMore || !cursor) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) {
      runQuery(query, true);
    }
  };

  const handlePick = async (gif: NormalizedGif) => {
    if (sendingId) return;
    setSendingId(gif.id);
    setError(undefined);
    try {
      const file = await downloadGifAsFile(gif);
      setOpen(false);
      onPickGif(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send that GIF');
    } finally {
      setSendingId(undefined);
    }
  };

  if (!enabled) return null;

  return (
    <div className="nu-gif-picker">
      <button
        type="button"
        className="nu-gif-picker__toggle"
        data-nu-role="gif-picker-toggle"
        title="GIFs"
        aria-label="GIFs"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="gif" size={20} />
      </button>
      {open && (
        <div className="nu-gif-picker__panel" data-nu-role="gif-picker-panel">
          <input
            type="text"
            className="nu-gif-picker__search"
            data-nu-role="gif-picker-search"
            placeholder="Search KLIPY"
            value={query}
            onChange={(evt) => handleQueryChange(evt.target.value)}
            autoFocus
          />
          <div className="nu-gif-picker__body" data-nu-role="gif-picker-body" ref={bodyRef} onScroll={handleScroll}>
            {error && (
              <p className="nu-gif-picker__error" data-nu-role="gif-picker-error">
                {error}
              </p>
            )}
            {!loading && gifs.length === 0 && !error && <p className="nu-gif-picker__empty">No GIFs found.</p>}
            <div className="nu-gif-picker__grid">
              {gifs.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  className="nu-gif-picker__item"
                  data-nu-role="gif-picker-item"
                  title={gif.title || 'GIF'}
                  disabled={!!sendingId}
                  onClick={() => void handlePick(gif)}
                  style={gif.preview.width && gif.preview.height ? { aspectRatio: `${gif.preview.width} / ${gif.preview.height}` } : undefined}
                >
                  <img className="nu-gif-picker__item-img" src={gif.preview.url} alt={gif.title} loading="lazy" />
                  {sendingId === gif.id && <span className="nu-gif-picker__item-spinner" aria-hidden="true" />}
                </button>
              ))}
            </div>
            {(loading || loadingMore) && <p className="nu-gif-picker__loading">Loading…</p>}
          </div>
          {/* Klipy's attribution requirement (docs.klipy.com/attribution) — "Search KLIPY" as the
              search placeholder above, plus this mark wherever its content appears. */}
          <div className="nu-gif-picker__attribution" data-nu-role="gif-picker-attribution">
            Powered by KLIPY
          </div>
        </div>
      )}
    </div>
  );
}
