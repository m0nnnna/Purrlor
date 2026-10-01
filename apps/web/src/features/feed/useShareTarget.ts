import { useEffect } from 'react';
import { useStore } from 'jotai';
import { composerFocusAtom, feedSearchAtom, sharedPostTextAtom } from '../../app/state/feed';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';

const SHARE_PARAMS = ['share_title', 'share_text', 'share_url'] as const;

/**
 * The post text for something shared from another app (manifest.webmanifest's share_target):
 * its title, text and link, each on its own line. Apps disagree about which field carries the
 * link, and many put it in the text too, so a link already in the text isn't repeated. Undefined
 * when nothing was shared.
 */
export function sharedPostText(params: URLSearchParams): string | undefined {
  const title = params.get('share_title')?.trim() ?? '';
  const text = params.get('share_text')?.trim() ?? '';
  const url = params.get('share_url')?.trim() ?? '';
  const lines = [title && !text.includes(title) ? title : '', text, url && !text.includes(url) ? url : ''];
  const body = lines.filter(Boolean).join('\n');
  return body || undefined;
}

/**
 * Sharing a link or some text to the installed app opens it at `/?share_text=…`: the global feed
 * opens with its composer focused and the text already in it. The parameters leave the address
 * bar straight away, so a reload doesn't share it twice.
 */
export function useShareTarget(): void {
  const store = useStore();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const text = sharedPostText(params);
    if (!SHARE_PARAMS.some((name) => params.has(name))) return;
    SHARE_PARAMS.forEach((name) => params.delete(name));
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    if (!text) return;

    store.set(openPostAtom, null);
    store.set(profileUserIdAtom, null);
    store.set(feedSearchAtom, '');
    store.set(globalFeedOpenAtom, true);
    store.set(sharedPostTextAtom, text);
    store.set(composerFocusAtom, (n) => n + 1);
  }, [store]);
}
