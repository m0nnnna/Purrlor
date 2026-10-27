import { lazy, Suspense, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { downloadLinks, formatDuration, type PublicStream } from '../../matrix/liveStream';
import { StreamChat } from './StreamChat';
import './Streaming.css';

const StreamPlayer = lazy(() => import('./StreamPlayer'));

/** The player, with livekit-client loaded only when a stream is shown. */
export function StreamPlayerLazy(props: { base: string; stream: PublicStream; mx?: MatrixClient }) {
  return (
    <Suspense fallback={<div className="nu-stream-player" data-nu-role="stream-player" />}>
      <StreamPlayer {...props} />
    </Suspense>
  );
}

function ago(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${Math.round(hours / 24)} days ago`;
}

/** "LIVE · 37 watching" or "Replay · 1:02:03 · ended 2 hours ago". */
export function StreamMeta({ stream }: { stream: PublicStream }) {
  if (stream.state === 'live') {
    return (
      <span className="nu-stream-meta" data-nu-role="stream-meta">
        <span className="nu-live-badge">LIVE</span>
        {stream.viewers === undefined ? null : stream.viewers === 1 ? '1 watching' : `${stream.viewers} watching`}
      </span>
    );
  }
  return (
    <span className="nu-stream-meta" data-nu-role="stream-meta">
      <span className="nu-live-badge nu-live-badge--replay">REPLAY</span>
      {stream.replay && formatDuration(stream.replay.durationMs)}
      {stream.endedAt && ` · ended ${ago(stream.endedAt)}`}
    </span>
  );
}

/**
 * On a profile, above the posts, pushing them down (docs/streaming.md): the owner's live stream,
 * or their newest replay, with its player. "Watch with chat" opens the watch page.
 */
export function ProfileStreamCard({
  base,
  stream,
  mx,
  onOpen,
}: {
  base: string;
  stream: PublicStream;
  mx?: MatrixClient;
  onOpen: () => void;
}) {
  return (
    <section className="nu-stream-card" data-nu-role="profile-stream" data-nu-state={stream.state}>
      <header className="nu-stream-card__head">
        <h2 className="nu-stream-card__title">{stream.title}</h2>
        <StreamMeta stream={stream} />
      </header>
      <StreamPlayerLazy base={base} stream={stream} mx={mx} />
      <div className="nu-stream-card__actions">
        <button type="button" className="nu-button nu-button--secondary" data-nu-role="profile-stream-open" onClick={onOpen}>
          {stream.state === 'live' ? 'Watch with chat' : 'Open the replay with its chat'}
        </button>
        {mx && mx.getUserId() === stream.owner && stream.state === 'ended' && <OwnerDownloads mx={mx} stream={stream} />}
      </div>
    </section>
  );
}

/** The streamer's own downloads: the replay file and the chat log. Nobody else gets these. */
export function OwnerDownloads({ mx, stream }: { mx: MatrixClient; stream: PublicStream }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const get = async (kind: 'replay' | 'chat') => {
    setBusy(true);
    setError(undefined);
    try {
      const links = await downloadLinks(mx, stream.id);
      const link = links[kind];
      if (!link) {
        setError(kind === 'replay' ? 'The replay isn’t ready yet.' : 'The chat log isn’t ready yet.');
        return;
      }
      const a = document.createElement('a');
      a.href = link;
      a.rel = 'noopener';
      a.click();
    } catch {
      setError('The download couldn’t start.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="nu-stream-downloads" data-nu-role="stream-downloads">
      <button type="button" className="nu-button nu-button--secondary" disabled={busy || !stream.replay} onClick={() => void get('replay')}>
        <Icon name="download" size={14} /> Replay
      </button>
      <button type="button" className="nu-button nu-button--secondary" disabled={busy} onClick={() => void get('chat')}>
        <Icon name="download" size={14} /> Chat log
      </button>
      {error && <span className="nu-stream-downloads__error">{error}</span>}
    </span>
  );
}

/** The watch page's body: the player and its chat, side by side (the chat under it on a phone). */
export function StreamWatch({
  base,
  stream,
  mx,
  onSignIn,
  ownerName,
  onOwner,
}: {
  base: string;
  stream: PublicStream;
  mx?: MatrixClient;
  onSignIn?: () => void;
  ownerName: string;
  onOwner?: () => void;
}) {
  return (
    <div className="nu-stream-watch" data-nu-role="stream-watch">
      <div className="nu-stream-watch__main">
        <StreamPlayerLazy base={base} stream={stream} mx={mx} />
        <div className="nu-stream-watch__info">
          <h1 className="nu-stream-watch__title" data-nu-role="stream-title">
            {stream.title}
          </h1>
          <StreamMeta stream={stream} />
          <p className="nu-stream-watch__owner">
            {onOwner ? (
              <button type="button" className="nu-stream-watch__owner-link" onClick={onOwner}>
                {ownerName}
              </button>
            ) : (
              ownerName
            )}
          </p>
          {mx && mx.getUserId() === stream.owner && stream.state === 'ended' && <OwnerDownloads mx={mx} stream={stream} />}
        </div>
      </div>
      <StreamChat base={base} stream={stream} mx={mx} onSignIn={onSignIn} />
    </div>
  );
}
