import { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Icon } from '../../components/Icon';
import { useBackCloses } from '../../app/navigationHistory';
import { fetchObsSettings, goLiveRefusalText, StreamError, type StreamSource } from '../../matrix/liveStream';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readIncludeSystemAudio, saveIncludeSystemAudio } from '../voice/voiceChannelRoomOptions';
import { maskKey, OBS_BITRATE_NOTE, OBS_SETTINGS, TITLE_MAX, titleOk } from './streamDashboard';
import { dashboardOpenAtom, setupOpenAtom, streamerAtom } from './streamerState';
import { imageToThumbnail } from './thumbnailImage';
import './Streaming.css';

/** livekit-client is its own chunk: loaded when someone goes live, not for everyone. */
export const streamerSession = () => import('./streamerSession');

/** "Go live" on your own profile: opens the setup page (SetupPage, mounted by the shell). */
export function GoLiveButton() {
  const status = useAtomValue(streamerAtom);
  const setOpen = useSetAtom(setupOpenAtom);
  if (status.phase !== 'idle' && status.phase !== 'error') return null;
  return (
    <button type="button" className="nu-follow-button nu-golive-button" data-nu-role="go-live" onClick={() => setOpen(true)}>
      <Icon name="tv" size={14} />
      Go live
    </button>
  );
}

type Obs = { state: 'loading' } | { state: 'off' } | { state: 'error' } | { state: 'ready'; url: string; key: string };

/** The go-live setup page: title, thumbnail, and where the picture comes from (this browser, or OBS). */
export function SetupPage() {
  const open = useAtomValue(setupOpenAtom);
  return open ? <Setup /> : null;
}

function Setup() {
  const mx = useMatrixClient();
  const store = useStore();
  const status = useAtomValue(streamerAtom);
  const setOpen = useSetAtom(setupOpenAtom);
  const setDashboard = useSetAtom(dashboardOpenAtom);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState<StreamSource>('browser');
  const [systemAudio, setSystemAudio] = useState(readIncludeSystemAudio);
  const [mic, setMic] = useState(false);
  const [thumb, setThumb] = useState<{ blob: Blob; url: string }>();
  const [error, setError] = useState<string>();
  const [obs, setObs] = useState<Obs>({ state: 'loading' });
  const starting = status.phase === 'starting';
  const close = () => (starting ? undefined : setOpen(false));
  useBackCloses(close);

  useEffect(() => {
    let cancelled = false;
    fetchObsSettings(mx)
      .then((found) => !cancelled && setObs({ state: 'ready', ...found }))
      .catch((err) => !cancelled && setObs({ state: err instanceof StreamError && err.code === 'obs_off' ? 'off' : 'error' }));
    return () => {
      cancelled = true;
    };
  }, [mx]);

  useEffect(() => () => (thumb ? URL.revokeObjectURL(thumb.url) : undefined), [thumb]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      const blob = await imageToThumbnail(file);
      setThumb({ blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t read that picture.');
    }
  };

  const start = async () => {
    setError(undefined);
    try {
      const session = await streamerSession();
      await session.goLive(mx, store, { title: title.trim(), source, includeSystemAudio: systemAudio, mic, thumbnail: thumb?.blob });
      const phase = store.get(streamerAtom).phase;
      if (phase === 'live' || phase === 'starting') {
        setOpen(false);
        setDashboard(true);
      }
    } catch (err) {
      setError(goLiveRefusalText(err));
    }
  };

  const obsReady = obs.state === 'ready';
  return (
    <div className="nu-stream-overlay" data-nu-role="go-live-page">
      <header className="nu-stream-overlay__header">
        <button type="button" className="nu-stream-overlay__back" data-nu-role="go-live-back" title="Back" aria-label="Back" disabled={starting} onClick={close}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1>Go live</h1>
      </header>
      <form
        className="nu-setup"
        data-nu-role="go-live-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <section className="nu-setup__column">
          <label className="nu-golive__field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              required
              autoFocus
              placeholder="What are you streaming?"
              data-nu-role="go-live-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="nu-golive__field">
            <span>Thumbnail (optional)</span>
            <div className="nu-setup__thumb">
              <div className="nu-setup__thumb-preview" data-nu-role="go-live-thumbnail-preview" style={thumb ? { backgroundImage: `url("${thumb.url}")` } : undefined}>
                {!thumb && <Icon name="image" size={28} />}
              </div>
              <div className="nu-setup__thumb-actions">
                <label className="nu-button nu-button--secondary">
                  {thumb ? 'Change picture' : 'Choose a picture'}
                  <input type="file" accept="image/*" hidden data-nu-role="go-live-thumbnail" onChange={(event) => void pick(event.target.files?.[0])} />
                </label>
                {thumb && (
                  <button type="button" className="nu-button nu-button--secondary" onClick={() => setThumb(undefined)}>
                    Remove
                  </button>
                )}
                <p className="nu-golive__hint">
                  Shown on cards and link previews. {source === 'browser' ? 'Without one, it’s a picture of your screen, renewed every minute.' : 'Without one, there’s none.'}
                </p>
              </div>
            </div>
          </div>
          <fieldset className="nu-setup__sources">
            <legend>Where is the picture from?</legend>
            <label className="nu-setup__source" data-nu-checked={source === 'browser'}>
              <input type="radio" name="source" checked={source === 'browser'} data-nu-role="go-live-source-browser" onChange={() => setSource('browser')} />
              <span>
                <strong>This browser</strong>
                <small>Share a screen, window or tab. 720p at 30 fps.</small>
              </span>
            </label>
            {obs.state !== 'off' && (
              <label className="nu-setup__source" data-nu-checked={source === 'obs'}>
                <input type="radio" name="source" checked={source === 'obs'} data-nu-role="go-live-source-obs" onChange={() => setSource('obs')} />
                <span>
                  <strong>OBS</strong>
                  <small>Send it from OBS Studio (or anything that speaks WHIP).</small>
                </span>
              </label>
            )}
            {obs.state === 'off' && (
              <p className="nu-golive__hint" data-nu-role="go-live-obs-off">
                Streaming from OBS isn’t set up on this server.
              </p>
            )}
          </fieldset>
          <p className="nu-golive__hint">Anyone can watch, signed in or not, and the stream is kept as a replay for 3 days.</p>
        </section>
        <section className="nu-setup__column">
          {source === 'browser' ? (
            <div className="nu-setup__panel" data-nu-role="go-live-browser">
              <h2>From this browser</h2>
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
              <p className="nu-golive__hint">Your browser asks which screen, window or tab to share when you press Go live. Streams are 720p at 30 fps.</p>
            </div>
          ) : (
            <ObsPanel obs={obs} onKey={(next) => setObs(next)} />
          )}
        </section>
        <footer className="nu-setup__footer">
          {error && (
            <p className="nu-golive__error" role="alert" data-nu-role="go-live-error">
              {error}
            </p>
          )}
          <div className="nu-golive__actions">
            <button type="button" className="nu-button nu-button--secondary" onClick={close} disabled={starting}>
              Cancel
            </button>
            <button
              type="submit"
              className="nu-button nu-button--primary"
              data-nu-role="go-live-start"
              disabled={starting || !titleOk(title) || (source === 'obs' && !obsReady)}
            >
              {starting ? 'Starting…' : 'Go live'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

/** What goes in OBS: the address and the key (hidden until shown), each with Copy, and a new key on request. */
function ObsPanel({ obs, onKey }: { obs: Obs; onKey: (next: Obs) => void }) {
  const mx = useMatrixClient();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<'url' | 'key'>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (obs.state === 'loading') return <div className="nu-setup__panel">Getting your OBS settings…</div>;
  if (obs.state === 'error') return <div className="nu-setup__panel nu-golive__error">Couldn’t get your OBS settings. Close this and try again.</div>;
  if (obs.state === 'off') return null;

  const copy = (what: 'url' | 'key') => {
    void navigator.clipboard?.writeText(what === 'url' ? obs.url : obs.key).catch(() => undefined);
    setCopied(what);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(undefined), 2000);
  };

  const reset = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const fresh = await fetchObsSettings(mx, true);
      onKey({ state: 'ready', ...fresh });
      setConfirming(false);
      setShown(true);
    } catch {
      setError('Couldn’t make a new key. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nu-setup__panel" data-nu-role="go-live-obs">
      <h2>From OBS</h2>
      <div className="nu-golive__field">
        <span>Server</span>
        <div className="nu-setup__copyrow">
          <input type="text" readOnly value={obs.url} data-nu-role="obs-url" onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="obs-url-copy" onClick={() => copy('url')}>
            {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="nu-golive__field">
        <span>Stream key</span>
        <div className="nu-setup__copyrow">
          <input
            type={shown ? 'text' : 'password'}
            readOnly
            value={shown ? obs.key : maskKey(obs.key)}
            data-nu-role="obs-key"
            aria-label="Stream key"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="obs-key-show" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </button>
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="obs-key-copy" onClick={() => copy('key')}>
            {copied === 'key' ? 'Copied' : 'Copy'}
          </button>
        </div>
        {confirming ? (
          <div className="nu-setup__confirm" data-nu-role="obs-reset-confirm">
            <span>Make a new key? The old one stops working at once, so OBS needs the new one.</span>
            <button type="button" className="nu-button nu-button--danger" data-nu-role="obs-reset-yes" disabled={busy} onClick={() => void reset()}>
              {busy ? 'Resetting…' : 'Reset key'}
            </button>
            <button type="button" className="nu-button nu-button--secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button type="button" className="nu-setup__link" data-nu-role="obs-reset" onClick={() => setConfirming(true)}>
            Reset key
          </button>
        )}
        {error && <p className="nu-golive__error">{error}</p>}
        <p className="nu-golive__hint">Keep the key to yourself: anyone with it can stream as you.</p>
      </div>
      <h3>In OBS</h3>
      <ol className="nu-setup__steps">
        <li>Settings → Stream → Service <strong>WHIP</strong>, Server the address above, Bearer Token the key.</li>
        {OBS_SETTINGS.map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>Press <strong>Go live</strong> here first, then <strong>Start Streaming</strong> in OBS.</li>
      </ol>
      <p className="nu-golive__hint">{OBS_BITRATE_NOTE}</p>
    </div>
  );
}
