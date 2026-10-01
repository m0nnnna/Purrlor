import { useEffect } from 'react';
import { useStore } from 'jotai';
import { composerFocusAtom, feedSearchAtom, sharedPostFilesAtom, sharedPostTextAtom } from '../../app/state/feed';
import { takeSharedFiles } from '../../matrix/shareFiles';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';

const SHARE_PARAMS = ['share_title', 'share_text', 'share_url', 'share_files'] as const;

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
 * Sharing a link, some text, pictures or video to the installed app opens it at `/?share_text=…`
 * (files come through the service worker, which adds `share_files=<count>`): the global feed opens
 * with its composer focused, the text already in it and the media staged. The parameters leave the
 * address bar straight away, so a reload doesn't share it twice.
 */
export function useShareTarget(): void {
  const store = useStore();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!SHARE_PARAMS.some((name) => params.has(name))) return;
    const text = sharedPostText(params);
    const fileCount = Number(params.get('share_files'));
    SHARE_PARAMS.forEach((name) => params.delete(name));
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);

    void (async () => {
      const files = fileCount ? await takeSharedFiles(fileCount) : [];
      if (!text && files.length === 0) return;
      store.set(openPostAtom, null);
      store.set(profileUserIdAtom, null);
      store.set(feedSearchAtom, '');
      store.set(globalFeedOpenAtom, true);
      store.set(sharedPostTextAtom, text ?? null);
      store.set(sharedPostFilesAtom, files.length ? files : null);
      store.set(composerFocusAtom, (n) => n + 1);
    })();
  }, [store]);
}
