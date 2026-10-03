import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { activeVoiceChannelIdAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { updateOwnPresence } from '../../matrix/account';
import { desktopBridge } from '../../desktop/desktopBridge';

/** How long without touching the keyboard or mouse before you show as Away. */
const IDLE_MINUTES = 10;

/**
 * In the desktop app: you show as Away when you've left the computer (no keyboard or mouse for
 * IDLE_MINUTES, or the PC locked), and Online again when you're back. The app reads Windows' own
 * idle timer (`watchIdle`), which only says how long since any input, never what it was, and only
 * idle or back reaches the page. Only an Online status is changed: Away or Invisible you set
 * yourself stays, and coming back only undoes an Away this set. Never during a call. Headless,
 * mounted once in AppShell.
 */
export function AutoAway() {
  const mx = useMatrixClient();
  const inCall = useAtomValue(activeVoiceChannelIdAtom) !== null;
  const inCallRef = useRef(inCall);
  inCallRef.current = inCall;

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let setByUs = false;
    const ownPresence = () => mx.getUser(mx.getUserId() ?? '')?.presence;

    const off = bridge.on('idle', (data) => {
      const { idle } = data as { idle: boolean };
      if (idle) {
        if (ownPresence() !== 'online' || inCallRef.current) return;
        setByUs = true;
        updateOwnPresence(mx, 'unavailable').catch(() => (setByUs = false));
      } else if (setByUs) {
        setByUs = false;
        if (ownPresence() === 'unavailable') updateOwnPresence(mx, 'online').catch(() => undefined);
      }
    });
    // Desktop 1.1.0 can't: nothing changes, as in a browser.
    bridge.request('watchIdle', { minutes: IDLE_MINUTES }).catch(() => undefined);
    return () => {
      off();
      bridge.request('watchIdle', { minutes: 0 }).catch(() => undefined);
    };
  }, [mx]);

  return null;
}
