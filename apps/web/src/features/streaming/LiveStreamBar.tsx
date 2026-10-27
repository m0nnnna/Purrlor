import { useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom, useStore } from 'jotai';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { fetchMyStream, formatDuration } from '../../matrix/liveStream';
import { Dashboard } from './Dashboard';
import { SetupPage, streamerSession } from './GoLive';
import { dashboardOpenAtom, openStreamAtom, streamerAtom } from './streamerState';
import './Streaming.css';

/**
 * Mounted once in the shell: the go-live setup page and the dashboard (opened over the app), the
 * pill that stays when the dashboard is closed, and picking a stream back up after a reload.
 */
export function StreamerHost() {
  const mx = useMatrixClient();
  const store = useStore();
  const setDashboard = useSetAtom(dashboardOpenAtom);
  useEffect(() => {
    let cancelled = false;
    void fetchMyStream(mx)
      .then(async (found) => {
        if (!found || cancelled) return;
        await (await streamerSession()).resumeStream(mx, store, found);
        if (!cancelled && store.get(streamerAtom).phase !== 'idle') setDashboard(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mx, store, setDashboard]);
  return (
    <>
      <SetupPage />
      <Dashboard />
      <LiveStreamBar />
    </>
  );
}

/**
 * While you stream, wherever you are in the app: "LIVE · 12 watching · Dashboard" and End stream.
 * A failed start says why here too.
 */
export function LiveStreamBar() {
  const mx = useMatrixClient();
  const store = useStore();
  const [status, setStatus] = useAtom(streamerAtom);
  const [dashboardOpen, setDashboard] = useAtom(dashboardOpenAtom);
  const setOpenStream = useSetAtom(openStreamAtom);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const live = status.phase === 'live';
  const lastLive = useRef(false);

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  // When it ends, the dashboard goes with it.
  useEffect(() => {
    if ((status.phase === 'idle' && lastLive.current) || status.phase === 'error') setDashboard(false);
    lastLive.current = status.phase !== 'idle';
  }, [status.phase, setDashboard]);

  if (status.phase === 'idle' || dashboardOpen) return null;
  if (status.phase === 'error') {
    return (
      <div className="nu-livebar nu-livebar--error" role="alert" data-nu-role="live-bar">
        <span>{status.message}</span>
        <button type="button" className="nu-livebar__button" onClick={() => setStatus({ phase: 'idle' })}>
          Dismiss
        </button>
      </div>
    );
  }
  if (status.phase === 'starting' && !status.stream) return null;

  const stream = status.phase === 'starting' || status.phase === 'live' || status.phase === 'stopping' || status.phase === 'orphan' ? status.stream : undefined;
  if (!stream) return null;
  const waiting = status.phase === 'starting';
  const act = (run: () => Promise<void>) => {
    setBusy(true);
    void run().finally(() => setBusy(false));
  };
  const end = () =>
    act(async () => {
      const session = await streamerSession();
      if (status.phase === 'orphan') await session.endOrphan(mx, store, stream);
      else await session.stopLive();
    });

  return (
    <div className="nu-livebar" data-nu-role="live-bar">
      <span className="nu-live-badge">{live ? 'LIVE' : waiting ? 'WAITING' : status.phase === 'orphan' ? 'LIVE' : 'ENDING'}</span>
      <button
        type="button"
        className="nu-livebar__title"
        title="Open your watch page"
        disabled={!live}
        onClick={() => setOpenStream({ owner: stream.owner, streamId: stream.id })}
      >
        {stream.title}
      </button>
      {live && (
        <span className="nu-livebar__meta" data-nu-role="live-bar-viewers">
          {formatDuration(now - (stream.liveAt ?? now))} · {status.viewers === 1 ? '1 watching' : `${status.viewers} watching`}
        </span>
      )}
      {waiting && <span className="nu-livebar__meta">Waiting for OBS…</span>}
      <button type="button" className="nu-livebar__button" data-nu-role="live-bar-dashboard" onClick={() => setDashboard(true)}>
        Dashboard
      </button>
      <button
        type="button"
        className="nu-livebar__button nu-livebar__button--stop"
        data-nu-role="live-bar-stop"
        disabled={busy || status.phase === 'stopping'}
        onClick={end}
      >
        {status.phase === 'stopping' ? 'Ending…' : 'End stream'}
      </button>
    </div>
  );
}

