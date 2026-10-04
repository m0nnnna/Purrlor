import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pops the active screen share out into its own real browser window — Discord's "pop out" for
 * screen share, one of the two items voice-architecture.md's "Deferred" list used to name (the
 * other, adaptive bitrate tiering, is left alone: this app's screen share already uses a
 * deliberately fixed high bitrate, see voiceChannelRoomOptions.ts's own comments, and swapping
 * that for LiveKit's adaptive/simulcast path isn't something to do without a live call to
 * verify it doesn't regress the tuning that's already there).
 *
 * Re-attaches the *same* `MediaStreamTrack` to a `<video>` in the new window rather than
 * building any UI there — it's still the one WebRTC connection, just rendered in two places.
 * Closes the popout automatically if the share ends, and forgets about it if the viewer closes
 * the window themselves.
 */
export function useScreenSharePopout(track: MediaStreamTrack | undefined): {
  isOpen: boolean;
  toggle: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const popoutRef = useRef<Window | null>(null);
  const pollRef = useRef<number>();

  const close = useCallback(() => {
    window.clearInterval(pollRef.current);
    if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
    popoutRef.current = null;
    setIsOpen(false);
  }, []);

  const open = useCallback(() => {
    const win = window.open('', 'purrlor-screen-share', 'width=960,height=540');
    if (!win) return; // popup blocked — nothing to fall back to, the user needs to allow popups
    win.document.title = 'Screen Share — Purrlor';
    win.document.body.style.margin = '0';
    win.document.body.style.background = '#000';
    win.document.body.style.overflow = 'hidden';
    const video = win.document.createElement('video');
    video.autoplay = true;
    video.style.width = '100vw';
    video.style.height = '100vh';
    video.style.objectFit = 'contain';
    win.document.body.appendChild(video);
    if (track) video.srcObject = new MediaStream([track]);
    popoutRef.current = win;
    setIsOpen(true);

    // No 'close' event exists for windows we don't control the lifecycle of from here, so poll.
    pollRef.current = window.setInterval(() => {
      if (win.closed) {
        window.clearInterval(pollRef.current);
        popoutRef.current = null;
        setIsOpen(false);
      }
    }, 500);
  }, [track]);

  const toggle = useCallback(() => {
    if (popoutRef.current && !popoutRef.current.closed) {
      close();
    } else {
      open();
    }
  }, [open, close]);

  // Keep the popout's <video> pointed at the current track; close it if the share ends.
  useEffect(() => {
    const win = popoutRef.current;
    if (!win || win.closed) return;
    if (!track) {
      close();
      return;
    }
    const video = win.document.querySelector('video');
    if (video) video.srcObject = new MediaStream([track]);
  }, [track, close]);

  // Close the popout when the call ends (ScreenShareProvider unmounts with it).
  useEffect(() => {
    return () => {
      window.clearInterval(pollRef.current);
      if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
    };
  }, []);

  return { isOpen, toggle };
}
