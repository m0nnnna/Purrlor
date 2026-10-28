import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { Icon } from '../../components/Icon';
import { ShareLinkButton } from '../../components/ShareLinkButton';
import { useBackCloses } from '../../app/navigationHistory';
import { formatDuration, moderateStream, StreamError, watchPath, type ModerateAction, type PublicStream } from '../../matrix/liveStream';
import { publicPagePath } from '../../matrix/publicWeb';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { streamerSession } from './GoLive';
import { describeHealth, runningTimeouts, TITLE_MAX, titleOk, type Health } from './streamDashboard';
import { StreamChat } from './StreamChat';
import { dashboardOpenAtom, openStreamAtom, streamerAtom } from './streamerState';
import './Streaming.css';

/**
 * The streamer's dashboard (docs/streaming.md, "The dashboard"): over the app while you stream, and
 * closed to a pill (LiveStreamBar.tsx) so you can still use it. The preview, how the picture is
 * doing, the title, what's shared (a browser stream), ending it, and the chat with moderation.
 */
export function Dashboard() {
  const open = useAtomValue(dashboardOpenAtom);
  const status = useAtomValue(streamerAtom);
  const stream = 'stream' in status ? status.stream : undefined;
  return open && stream ? <DashboardPage stream={stream} /> : null;
}

function DashboardPage({ stream }: { stream: PublicStream }) {
  const mx = useMatrixClient();
  const store = useStore();
  const status = useAtomValue(streamerAtom);
  const setOpen = useSetAtom(dashboardOpenAtom);
  const [openStream, setOpenStream] = useAtom(openStreamAtom);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useBackCloses(close);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<Health>();
  const [title, setTitle] = useState(stream.title);
  const [timeouts, setTimeouts] = useState<Record<string, number>>({});
  const [banned, setBanned] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const soundRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [previewOff, setPreviewOff] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const phase = status.phase;
  const live = status.phase === 'live';
  const waiting = status.phase === 'starting';
  const orphan = status.phase === 'orphan';
  const source = stream.source;
  const browserLive = live && source === 'browser';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // The picture: the shared screen, or for OBS the preview room (it shows before the stream is live too).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || orphan || phase === 'stopping') return undefined;
    let undo: (() => void) | undefined;
    let cancelled = false;
    void streamerSession().then((session) => {
      if (cancelled) return;
      undo = session.attachPreview(video, soundRef.current ?? undefined);
    });
    const onPlaying = () => setHasPicture(true);
    video.addEventListener('loadeddata', onPlaying);
    return () => {
      cancelled = true;
      undo?.();
      video.removeEventListener('loadeddata', onPlaying);
      setHasPicture(false);
    };
  }, [phase, source, orphan]);

  // Listening in: OBS's sound, off by default so it doesn't echo into a microphone OBS is capturing.
  useEffect(() => {
    soundRef.current?.querySelectorAll('audio').forEach((element) => {
      element.muted = !listening;
      element.volume = volume;
    });
  }, [listening, volume, hasPicture]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === previewRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void previewRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  // How the picture is doing, from WebRTC's stats, every 2 s.
  useEffect(() => {
    if (orphan || phase === 'stopping') return undefined;
    let cancelled = false;
    const read = () => void streamerSession().then((session) => session.readHealth()).then((found) => !cancelled && setHealth(found)).catch(() => undefined);
    read();
    const timer = window.setInterval(read, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, orphan]);

  const act = (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    run()
      .catch((err) => setError(err instanceof Error && err.message ? err.message : 'That didn’t work.'))
      .finally(() => setBusy(false));
  };

  const session = () => streamerSession();
  const end = () =>
    act(async () => {
      if (orphan) await (await session()).endOrphan(mx, store, stream);
      else await (await session()).stopLive();
    });

  const moderate = (what: ModerateAction) => {
    setError(undefined);
    moderateStream(mx, stream.id, what)
      .then((running) => {
        setTimeouts(running);
        if (what.action === 'ban') setBanned((prev) => (prev.includes(what.user) ? prev : [...prev, what.user]));
        if (what.action === 'unban') setBanned((prev) => prev.filter((user) => user !== what.user));
      })
      .catch((err) => setError(err instanceof StreamError && err.code === 'ended' ? 'The stream has ended, so the chat can’t be moderated.' : 'That didn’t work. Try again.'));
  };

  const elapsed = live && stream.liveAt ? formatDuration(now - stream.liveAt) : '0:00';
  const running = runningTimeouts(timeouts, now);
  const titleChanged = title.trim() !== stream.title && titleOk(title);
  const nameOf = (user: string) => user.replace(/^@/, '').replace(/:.*$/, '');

  return (
    <div className="nu-stream-overlay nu-dash" data-nu-role="dashboard">
      <header className="nu-stream-overlay__header">
        <button type="button" className="nu-stream-overlay__back" data-nu-role="dashboard-close" title="Back to Purrlor" aria-label="Back to Purrlor" onClick={close}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1>Dashboard</h1>
        {live && <span className="nu-live-badge">LIVE</span>}
        {waiting && (
          <span className="nu-dash__state" data-nu-role="dashboard-state">
            {source === 'obs' ? 'Waiting for OBS…' : 'Starting…'}
          </span>
        )}
        {orphan && <span className="nu-dash__state">Still running</span>}
        <span className="nu-dash__spacer" />
        {live && (
          <button type="button" className="nu-button nu-button--secondary" onClick={() => setOpenStream({ owner: stream.owner, streamId: stream.id })} disabled={openStream?.streamId === stream.id}>
            Open watch page
          </button>
        )}
        <button type="button" className="nu-button nu-button--danger" data-nu-role="dashboard-stop" disabled={busy || phase === 'stopping'} onClick={end}>
          {phase === 'stopping' ? 'Ending…' : 'End stream'}
        </button>
      </header>
      <div className="nu-dash__body">
        <section className="nu-dash__main">
          {orphan ? (
            <div className="nu-dash__orphan" data-nu-role="dashboard-orphan">
              <p>
                <strong>“{stream.title}”</strong> is still running on the server, but this page was reloaded, and a stream from the browser can’t be picked up again: its picture
                is gone. End it, then go live again.
              </p>
            </div>
          ) : (
            <div ref={previewRef} className="nu-dash__preview">
              <video ref={videoRef} className="nu-dash__video" data-nu-role="dashboard-preview" muted playsInline autoPlay hidden={previewOff} onDoubleClick={toggleFullscreen} />
              <div ref={soundRef} hidden />
              {previewOff && <div className="nu-dash__waiting">The preview is off. Your stream is still going.</div>}
              {hasPicture && (
                <div className="nu-stream-player__controls nu-dash__player" data-nu-role="dashboard-player">
                  {source === 'obs' && (
                    <>
                      <button
                        type="button"
                        onClick={() => setListening(!listening)}
                        title={listening ? 'Stop listening' : 'Listen to your stream'}
                        aria-label={listening ? 'Stop listening' : 'Listen to your stream'}
                        aria-pressed={listening}
                        data-nu-role="dashboard-listen"
                      >
                        <Icon name={listening ? 'volume' : 'volumeOff'} size={18} />
                      </button>
                      <input
                        type="range"
                        className="nu-stream-player__volume"
                        min={0}
                        max={1}
                        step={0.05}
                        value={listening ? volume : 0}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setVolume(next || volume);
                          setListening(next > 0);
                        }}
                        aria-label="Preview volume"
                        data-nu-role="dashboard-volume"
                      />
                    </>
                  )}
                  <span className="nu-stream-player__spacer" />
                  <button type="button" onClick={() => setPreviewOff(!previewOff)} aria-pressed={previewOff} data-nu-role="dashboard-preview-toggle">
                    {previewOff ? 'Show preview' : 'Hide preview'}
                  </button>
                  <button type="button" onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} data-nu-role="dashboard-fullscreen">
                    <Icon name={fullscreen ? 'minimize' : 'maximize'} size={18} />
                  </button>
                </div>
              )}
              {!hasPicture && (
                <div className="nu-dash__waiting" data-nu-role="dashboard-waiting">
                  {source === 'obs' ? (waiting ? 'Waiting for OBS… press Start Streaming in OBS' : 'Waiting for the picture…') : 'Waiting for the picture…'}
                </div>
              )}
            </div>
          )}
          {!orphan && (
            <dl className="nu-dash__stats" data-nu-role="dashboard-stats">
              <div>
                <dt>Picture</dt>
                <dd data-nu-role="dashboard-health">{describeHealth(health)}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd data-nu-role="dashboard-elapsed">{elapsed}</dd>
              </div>
              <div>
                <dt>Watching</dt>
                <dd data-nu-role="dashboard-viewers">{live ? status.viewers : 0}</dd>
              </div>
            </dl>
          )}
          {live && <SharePanel stream={stream} />}
          {live && (
            <form
              className="nu-dash__title"
              onSubmit={(event) => {
                event.preventDefault();
                if (titleChanged) act(async () => (await session()).renameLive(title.trim()));
              }}
            >
              <label className="nu-golive__field">
                <span>Title</span>
                <input type="text" value={title} maxLength={TITLE_MAX} data-nu-role="dashboard-title" onChange={(event) => setTitle(event.target.value)} />
              </label>
              <button type="submit" className="nu-button nu-button--primary" data-nu-role="dashboard-title-save" disabled={busy || !titleChanged}>
                Save
              </button>
            </form>
          )}
          {live && (
            <div className="nu-dash__controls">
              {browserLive && (
                <>
                  <button type="button" className="nu-button nu-button--secondary" data-nu-role="dashboard-change-screen" disabled={busy} onClick={() => act(async () => (await session()).changeScreen())}>
                    <Icon name="monitor" size={14} /> Share another screen
                  </button>
                  <button
                    type="button"
                    className="nu-button nu-button--secondary"
                    data-nu-role="dashboard-mic"
                    aria-pressed={status.micOn}
                    disabled={busy}
                    onClick={() => act(async () => (await session()).setMicrophone(!status.micOn))}
                  >
                    <Icon name={status.micOn ? 'mic' : 'micOff'} size={14} /> Microphone {status.micOn ? 'on' : 'off'}
                  </button>
                  <SoundToggle on={status.soundOn} busy={busy} act={act} />
                </>
              )}
              <button type="button" className="nu-button nu-button--secondary" data-nu-role="live-bar-post" disabled={busy || status.posted} onClick={() => act(async () => (await session()).postAboutStream())}>
                {status.posted ? 'Posted' : 'Post to feed'}
              </button>
            </div>
          )}
          {error && (
            <p className="nu-golive__error" role="alert" data-nu-role="dashboard-error">
              {error}
            </p>
          )}
        </section>
        <aside className="nu-dash__side">
          <StreamChat base="" stream={stream} mx={mx} moderate={moderate} />
          {(running.length > 0 || banned.length > 0) && (
            <div className="nu-dash__mod" data-nu-role="dashboard-timeouts">
              <h2>In the chat’s penalty box</h2>
              <ul>
                {running.map((t) => (
                  <li key={`t-${t.user}`}>
                    <span>
                      {nameOf(t.user)} · {t.minutesLeft} min left
                    </span>
                    <button type="button" className="nu-button nu-button--secondary" data-nu-role="mod-untimeout" onClick={() => moderate({ action: 'untimeout', user: t.user })}>
                      Untimeout
                    </button>
                  </li>
                ))}
                {banned.map((user) => (
                  <li key={`b-${user}`}>
                    <span>{nameOf(user)} · banned</span>
                    <button type="button" className="nu-button nu-button--secondary" data-nu-role="mod-unban" onClick={() => moderate({ action: 'unban', user })}>
                      Unban
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Other sites the watch page can be posted to. Each opens the site's own "post this" page in a new tab. */
const SHARE_SITES: { name: string; url: (link: string, text: string) => string }[] = [
  { name: 'X', url: (link, text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}` },
  { name: 'Bluesky', url: (link, text) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text} ${link}`)}` },
  { name: 'Reddit', url: (link, text) => `https://www.reddit.com/submit?url=${encodeURIComponent(link)}&title=${encodeURIComponent(text)}` },
  { name: 'Facebook', url: (link) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}` },
];

/** The watch page's link, to copy (or the phone's share sheet) or to post on another site. */
function SharePanel({ stream }: { stream: PublicStream }) {
  const link = `${window.location.origin}${watchPath(publicPagePath(stream.owner), stream.id)}`;
  const text = `Live now: ${stream.title}`;
  return (
    <div className="nu-dash__share" data-nu-role="dashboard-share">
      <input className="nu-field__input" readOnly value={link} aria-label="Your stream’s link" onFocus={(event) => event.target.select()} data-nu-role="dashboard-share-link" />
      <ShareLinkButton url={link} title={text} label="Copy link" role="dashboard-share-copy" />
      {SHARE_SITES.map((site) => (
        <a key={site.name} className="nu-button nu-button--secondary" href={site.url(link, text)} target="_blank" rel="noopener noreferrer" data-nu-role={`dashboard-share-${site.name.toLowerCase()}`}>
          {site.name}
        </a>
      ))}
    </div>
  );
}

/** The shared sound on or off; only there if the sound was asked for when going live. */
function SoundToggle({ on, busy, act }: { on: boolean; busy: boolean; act: (run: () => Promise<void>) => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    void streamerSession().then((session) => setAvailable(session.hasSharedSound()));
  }, []);
  if (!available) return null;
  return (
    <button type="button" className="nu-button nu-button--secondary" data-nu-role="dashboard-sound" aria-pressed={on} disabled={busy} onClick={() => act(async () => (await (await streamerSession()).setSharedSound(!on)))}>
      <Icon name={on ? 'volume' : 'volumeOff'} size={14} /> Shared sound {on ? 'on' : 'off'}
    </button>
  );
}
