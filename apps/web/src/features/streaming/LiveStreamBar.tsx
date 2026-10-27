import { useEffect, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { Icon } from '../../components/Icon';
import { formatDuration } from '../../matrix/liveStream';
import { streamerSession } from './GoLive';
import { openStreamAtom, streamerAtom } from './streamerState';
import './Streaming.css';

/**
 * While you're live, wherever you are in the app: the title, how long, how many are watching, and
 * the microphone, "Post to feed", your watch page and Stop. A failed start says why here too.
 */
export function LiveStreamBar() {
  const [status, setStatus] = useAtom(streamerAtom);
  const setOpenStream = useSetAtom(openStreamAtom);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const live = status.phase === 'live';

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (status.phase === 'idle' || status.phase === 'starting') return null;
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

  const stream = status.stream;
  const act = (run: () => Promise<void>) => {
    setBusy(true);
    void run().finally(() => setBusy(false));
  };

  return (
    <div className="nu-livebar" data-nu-role="live-bar">
      <span className="nu-live-badge">LIVE</span>
      <button
        type="button"
        className="nu-livebar__title"
        title="Open your watch page"
        onClick={() => setOpenStream({ owner: stream.owner, streamId: stream.id })}
      >
        {stream.title}
      </button>
      {live && (
        <span className="nu-livebar__meta" data-nu-role="live-bar-viewers">
          {formatDuration(now - (stream.liveAt ?? now))} · {status.viewers === 1 ? '1 watching' : `${status.viewers} watching`}
        </span>
      )}
      {live && (
        <>
          <button
            type="button"
            className="nu-livebar__button"
            aria-pressed={status.micOn}
            title={status.micOn ? 'Turn the microphone off' : 'Turn the microphone on'}
            disabled={busy}
            onClick={() => act(async () => (await streamerSession()).setMicrophone(!status.micOn))}
          >
            <Icon name={status.micOn ? 'mic' : 'micOff'} size={14} />
          </button>
          <button
            type="button"
            className="nu-livebar__button"
            data-nu-role="live-bar-post"
            disabled={busy || status.posted}
            onClick={() => act(async () => (await streamerSession()).postAboutStream())}
          >
            {status.posted ? 'Posted' : 'Post to feed'}
          </button>
        </>
      )}
      <button
        type="button"
        className="nu-livebar__button nu-livebar__button--stop"
        data-nu-role="live-bar-stop"
        disabled={status.phase === 'stopping'}
        onClick={() => act(async () => (await streamerSession()).stopLive())}
      >
        {status.phase === 'stopping' ? 'Ending…' : 'End stream'}
      </button>
    </div>
  );
}
