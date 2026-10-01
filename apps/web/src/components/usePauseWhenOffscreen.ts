import { useCallback, useRef } from 'react';

/**
 * A ref for a `<video>` (or `<audio>`) that pauses it whenever it isn't on screen: scrolled out of
 * view, or in a part of the app that's still mounted but hidden (the global feed stays alive under
 * a chat, so without this a video kept playing, sound and all, after you'd left it). It only ever
 * pauses: coming back doesn't resume anything, since the reader chose to play it. Does nothing
 * where IntersectionObserver doesn't exist.
 *
 * It's a callback ref rather than an effect so it also works for a player that only appears once
 * its file has loaded.
 */
export function usePauseWhenOffscreen(): (element: HTMLMediaElement | null) => void {
  const observer = useRef<IntersectionObserver>();
  return useCallback((element: HTMLMediaElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && !element.paused) element.pause();
      }
    });
    observer.current.observe(element);
  }, []);
}
