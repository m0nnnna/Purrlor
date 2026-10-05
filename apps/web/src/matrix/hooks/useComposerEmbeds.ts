import { useCallback, useEffect, useRef, useState } from 'react';
import { useMatrixClient } from '../MatrixClientContext';
import { embeddableLinks, type StoredEmbed } from '../embeds';
import { prepareEmbedsReporting, resolveLink, type ResolvedLink } from '../embedResolve';

/** How long typing has to pause before the links in it are looked up. */
const SETTLE_MS = 500;
/** The longest a send waits for its embeds; past it, the message goes without the slow ones. */
const SEND_WAIT_MS = 8000;

export type ComposerEmbed = { url: string; status: 'loading' | 'ready' | 'none'; link?: ResolvedLink };

export type ComposerEmbeds = {
  /** What will be embedded, for the composer's preview: one per link not removed. */
  previews: ComposerEmbed[];
  remove: (url: string) => void;
  /**
   * The embeds content for sending `body`: undefined when it has no links, or none could be looked
   * up at all (the field is left out, so readers fall back to the homeserver's preview), otherwise
   * the list (possibly empty: links removed or with nothing to show, which then also keeps the
   * homeserver from previewing them).
   */
  prepare: (body: string) => Promise<StoredEmbed[] | undefined>;
  /** After a send: forget what was removed. */
  reset: () => void;
};

/**
 * A composer's link embeds (docs/embeds.md): each link looked up once typing pauses, so the
 * preview shows what will be embedded and sending doesn't wait on sites; removed ones stay
 * removed; and on send, pictures uploaded as the sender's (encrypted when `encrypt`).
 */
export function useComposerEmbeds(body: string, enabled: boolean, encrypt: boolean): ComposerEmbeds {
  const mx = useMatrixClient();
  const [links, setLinks] = useState<string[]>([]);
  const [states, setStates] = useState<Map<string, ComposerEmbed>>(new Map());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const removedRef = useRef(removed);
  removedRef.current = removed;

  useEffect(() => {
    if (!enabled) {
      setLinks([]);
      return undefined;
    }
    const timer = setTimeout(() => setLinks(embeddableLinks(body)), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [body, enabled]);

  useEffect(() => {
    let cancelled = false;
    for (const url of links) {
      if (states.has(url)) continue;
      setStates((current) => new Map(current).set(url, { url, status: 'loading' }));
      void resolveLink(mx, url).then((link) => {
        if (cancelled) return;
        setStates((current) => new Map(current).set(url, link ? { url, status: 'ready', link } : { url, status: 'none' }));
      });
    }
    return () => {
      cancelled = true;
    };
    // Only new links start a lookup; `states` changing because of one mustn't start another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, mx]);

  const remove = useCallback((url: string) => setRemoved((current) => new Set(current).add(url)), []);
  const reset = useCallback(() => {
    setRemoved(new Set());
    setLinks([]);
  }, []);

  const prepare = useCallback(
    async (text: string) => {
      if (!enabled) return undefined;
      const all = embeddableLinks(text);
      if (all.length === 0) return undefined;
      const wanted = all.filter((url) => !removedRef.current.has(url));
      if (wanted.length === 0) return [];
      const timeout = new Promise<{ embeds: StoredEmbed[]; anyFailed: boolean }>((resolve) =>
        setTimeout(() => resolve({ embeds: [], anyFailed: true }), SEND_WAIT_MS)
      );
      const { embeds, anyFailed } = await Promise.race([prepareEmbedsReporting(mx, wanted, encrypt), timeout]);
      const removedAny = wanted.length < all.length;
      return embeds.length === 0 && anyFailed && !removedAny ? undefined : embeds;
    },
    [enabled, encrypt, mx]
  );

  const previews = links.filter((url) => !removed.has(url)).map((url) => states.get(url) ?? { url, status: 'loading' as const });
  return { previews: previews.filter((preview) => preview.status !== 'none'), remove, prepare, reset };
}
