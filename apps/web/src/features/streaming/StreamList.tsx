import { useState, type Dispatch, type SetStateAction } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { deleteStream, renameStream, type PublicStream } from '../../matrix/liveStream';
import { OwnerDownloads, StreamMeta } from './StreamViews';
import './Streaming.css';

/** "gone in 2 days": when an ended stream's replay and chat log are deleted. */
function goneIn(expiresAt: number): string {
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (minutes < 1) return 'gone any moment';
  if (minutes < 60) return `gone in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `gone in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `gone in ${days} day${days === 1 ? '' : 's'}`;
}

function StreamTile({
  base,
  stream,
  mx,
  isOwner,
  onOpen,
  onRenamed,
  onDeleted,
}: {
  base: string;
  stream: PublicStream;
  mx: MatrixClient;
  isOwner: boolean;
  onOpen: () => void;
  onRenamed: (stream: PublicStream) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ended = stream.state === 'ended';

  const saveTitle = async () => {
    const next = title?.trim();
    if (!next || next === stream.title) {
      setTitle(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onRenamed(await renameStream(mx, stream.id, next));
      setTitle(undefined);
    } catch {
      setError('Couldn’t rename it. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteStream(mx, stream.id);
      onDeleted();
    } catch {
      setError('Couldn’t delete it. Try again.');
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <li className="nu-stream-tile" data-nu-role="stream-tile" data-nu-state={stream.state}>
      <button type="button" className="nu-stream-tile__open" data-nu-role="stream-tile-open" onClick={onOpen}>
        <span className="nu-stream-tile__thumb">
          {stream.thumbnail ? <img src={`${base}${stream.thumbnail}`} alt="" loading="lazy" /> : <span className="nu-stream-tile__placeholder" />}
        </span>
        <span className="nu-stream-tile__title">{stream.title}</span>
      </button>
      <StreamMeta stream={stream} />
      {ended && (
        <p className="nu-stream-tile__note" data-nu-role="stream-tile-note">
          {!stream.replay && (stream.saving ? 'Being saved…' : 'No replay')}
          {!stream.replay && stream.expiresAt ? ' · ' : ''}
          {stream.expiresAt ? goneIn(stream.expiresAt) : ''}
        </p>
      )}
      {isOwner && (
        <div className="nu-stream-tile__actions" data-nu-role="stream-tile-actions">
          {title !== undefined ? (
            <input
              className="nu-stream-tile__rename"
              data-nu-role="stream-tile-rename-input"
              aria-label="Stream title"
              value={title}
              maxLength={120}
              autoFocus
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle();
                if (e.key === 'Escape') setTitle(undefined);
              }}
            />
          ) : (
            <button type="button" className="nu-button nu-button--secondary" data-nu-role="stream-tile-rename" onClick={() => setTitle(stream.title)}>
              Rename
            </button>
          )}
          {ended && <OwnerDownloads mx={mx} stream={stream} />}
          {ended &&
            (confirming ? (
              <span className="nu-stream-tile__confirm" data-nu-role="stream-tile-confirm">
                Delete for good?
                <button type="button" className="nu-button nu-button--danger" data-nu-role="stream-tile-delete-yes" disabled={busy} onClick={() => void remove()}>
                  Yes
                </button>
                <button type="button" className="nu-button nu-button--secondary" data-nu-role="stream-tile-delete-no" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="nu-button nu-button--secondary" data-nu-role="stream-tile-delete" onClick={() => setConfirming(true)}>
                Delete
              </button>
            ))}
        </div>
      )}
      {error && (
        <p className="nu-stream-tile__error" role="alert" data-nu-role="stream-tile-error">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The profile's Streams tab (docs/streaming.md): a person's live and unexpired streams, newest
 * first. The streamer also gets rename, download and delete on each. `setStreams` is the list's
 * owner's setter, so a rename or delete shows at once.
 */
export function StreamList({
  base,
  owner,
  mx,
  streams,
  setStreams,
  onOpen,
}: {
  base: string;
  owner: string;
  mx: MatrixClient;
  streams: PublicStream[];
  setStreams: Dispatch<SetStateAction<PublicStream[] | undefined>>;
  onOpen: (stream: PublicStream) => void;
}) {
  const isOwner = mx.getUserId() === owner;
  if (streams.length === 0) {
    return (
      <p className="nu-feed__status" data-nu-role="stream-list-empty">
        {isOwner ? 'Your streams and their replays show here for 3 days after they end.' : 'No streams to show.'}
      </p>
    );
  }
  return (
    <ul className="nu-stream-list" data-nu-role="stream-list">
      {streams.map((stream) => (
        <StreamTile
          key={stream.id}
          base={base}
          stream={stream}
          mx={mx}
          isOwner={isOwner}
          onOpen={() => onOpen(stream)}
          onRenamed={(next) => setStreams((list) => list?.map((s) => (s.id === next.id ? next : s)))}
          onDeleted={() => setStreams((list) => list?.filter((s) => s.id !== stream.id))}
        />
      ))}
    </ul>
  );
}
