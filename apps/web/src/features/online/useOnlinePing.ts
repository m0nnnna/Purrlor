import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { onlineCountAtom, pingOnline } from './onlineApi';

/** Apps ping this often while showing; the token server counts an account for 2½ minutes. */
const PING_MS = 60_000;

/**
 * While the app is on screen, says so about once a minute (and at once when it comes back into
 * view), keeping the "N online" count fresh with each answer. A hidden tab doesn't ping, so it
 * drops out of the count within a few minutes.
 */
export function useOnlinePing(): void {
  const mx = useMatrixClient();
  const setCount = useSetAtom(onlineCountAtom);

  useEffect(() => {
    let cancelled = false;
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      void pingOnline(mx).then((count) => {
        if (!cancelled && count !== undefined) setCount(count);
      });
    };
    ping();
    const timer = setInterval(ping, PING_MS);
    const onVisibility = () => document.visibilityState === 'visible' && ping();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mx, setCount]);
}
