import { useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { goLiveRefusalText } from '../../matrix/liveStream';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readIncludeSystemAudio, saveIncludeSystemAudio } from '../voice/voiceChannelRoomOptions';
import { streamerAtom } from './streamerState';
import './Streaming.css';

/** livekit-client is its own chunk: loaded when someone goes live, not for everyone. */
export const streamerSession = () => import('./streamerSession');

/** "Go live" on your own profile, and the dialog that starts it. */
export function GoLiveButton() {
  const status = useAtomValue(streamerAtom);
  const [open, setOpen] = useState(false);
  if (status.phase === 'live' || status.phase === 'stopping') return null;
  return (
    <>
      <button type="button" className="nu-follow-button nu-golive-button" data-nu-role="go-live" onClick={() => setOpen(true)}>
        <Icon name="tv" size={14} />
        Go live
      </button>
      {open && <GoLiveModal onClose={() => setOpen(false)} />}
    </>
  );
}

function GoLiveModal({ onClose }: { onClose: () => void }) {
  const mx = useMatrixClient();
  const store = useStore();
  const status = useAtomValue(streamerAtom);
  const [title, setTitle] = useState('');
  const [systemAudio, setSystemAudio] = useState(readIncludeSystemAudio);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string>();
  const starting = status.phase === 'starting';

  const start = async () => {
    setError(undefined);
    try {
      const session = await streamerSession();
      await session.goLive(mx, store, { title: title.trim(), includeSystemAudio: systemAudio, mic });
      if (store.get(streamerAtom).phase === 'live') onClose();
    } catch (err) {
      setError(goLiveRefusalText(err));
    }
  };

  return (
    <Modal title="Go live" onClose={starting ? () => undefined : onClose}>
      <form
        className="nu-golive"
        data-nu-role="go-live-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="nu-golive__field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            maxLength={120}
            required
            autoFocus
            placeholder="What are you streaming?"
            data-nu-role="go-live-title"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="nu-golive__check">
          <input
            type="checkbox"
            checked={systemAudio}
            onChange={(event) => {
              setSystemAudio(event.target.checked);
              saveIncludeSystemAudio(event.target.checked);
            }}
          />
          Share my computer’s sound too
        </label>
        <label className="nu-golive__check">
          <input type="checkbox" checked={mic} data-nu-role="go-live-mic" onChange={(event) => setMic(event.target.checked)} />
          Turn on my microphone
        </label>
        <p className="nu-golive__hint">
          Anyone can watch, signed in or not, and the stream is kept as a replay for 3 days. Your browser asks which screen, window or tab to
          share. Streams are 720p at 30 fps.
        </p>
        {error && (
          <p className="nu-golive__error" role="alert" data-nu-role="go-live-error">
            {error}
          </p>
        )}
        <div className="nu-golive__actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose} disabled={starting}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="go-live-start" disabled={starting || !title.trim()}>
            {starting ? 'Starting…' : 'Go live'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
