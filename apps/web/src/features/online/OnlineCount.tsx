import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { fetchOnline, onlineCountAtom } from './onlineApi';
import './OnlineCount.css';

function Badge({ count }: { count: number }) {
  const label = `${count.toLocaleString()} online`;
  return (
    <span className="nu-online-count" data-nu-role="online-count" title={`${label} now`} aria-label={`${label} now`}>
      <span className="nu-online-count__dot" aria-hidden="true" />
      <span className="nu-online-count__number">{count.toLocaleString()}</span>
      <span className="nu-online-count__word">online</span>
    </span>
  );
}

/** "● N online" for the global feed, from the app's own pings (useOnlinePing). Nothing until known. */
export function OnlineCount() {
  const count = useAtomValue(onlineCountAtom);
  return count === null ? null : <Badge count={count} />;
}

/** The same for the signed-out feed, which doesn't ping: it asks once a minute. */
export function PublicOnlineCount() {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void fetchOnline().then((value) => {
        if (!cancelled && value !== undefined) setCount(value);
      });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return count === undefined ? null : <Badge count={count} />;
}
