import { useEffect } from 'react';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { startHistoryPrefetch } from '../../matrix/historyPrefetch';

/** Gives the app a moment to draw first; the fill is background work. */
const START_DELAY_MS = 2000;

/**
 * Fills each room's recent history in the background after start (matrix/historyPrefetch.ts), so
 * opening a room shows its messages at once. Headless, mounted in AppShell.
 */
export function HistoryPrefetch() {
  const mx = useMatrixClient();
  useEffect(() => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop = startHistoryPrefetch(mx);
    }, START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [mx]);
  return null;
}
