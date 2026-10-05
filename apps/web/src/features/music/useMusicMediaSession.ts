import { useEffect } from 'react';
import { useAtom } from 'jotai';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { musicAudio, musicQueueAtom } from './musicPlayer';

/**
 * Tells the system what the player is playing (the Media Session API), so the keyboard's media
 * keys, a headset's buttons and Windows' media flyout control it, showing the track and its cover.
 * The browser, or the desktop app's WebView2, routes the keys here only while this is the media
 * session the system is following, so it never takes them from another music app that's playing.
 */
export function useMusicMediaSession(): void {
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const item = queue?.items[queue.index];
  const cover = useMediaUrl(item?.cover, { width: 256, height: 256, method: 'scale', blob: true });

  useEffect(() => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session || typeof MediaMetadata === 'undefined') return;
    if (!queue || !item) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      title: item.track.title,
      artist: item.track.artist ?? '',
      album: item.albumTitle ?? '',
      artwork: cover ? [{ src: cover, sizes: '256x256' }] : [],
    });
    const go = (index: number) => {
      if (index >= 0 && index < queue.items.length) setQueue({ ...queue, index });
    };
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => void musicAudio()?.play().catch(() => undefined)],
      ['pause', () => musicAudio()?.pause()],
      // Back to the start of this track if it's been playing a while, as players do; otherwise the one before.
      ['previoustrack', () => {
        const audio = musicAudio();
        if (audio && audio.currentTime > 3) audio.currentTime = 0;
        else go(queue.index - 1);
      }],
      ['nexttrack', queue.index + 1 < queue.items.length ? () => go(queue.index + 1) : null],
      ['stop', () => setQueue(null)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // An action this browser doesn't know.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [queue, item, cover, setQueue]);
}
