import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import type { MatrixClient } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { refusalText, StreamError, viewerToken, type PublicStream } from '../../matrix/liveStream';
import { VIEWER_ROOM_OPTIONS } from './streamRoomOptions';

/**
 * Watching a stream (docs/streaming.md, "Where people watch"): nothing is fetched until play is
 * pressed. Then a viewer token from the stream's server and a receive-only connection, at the
 * layer that fits the player (adaptive stream), with an audio-only switch that stops the video.
 * A replay is a plain video file from the same server.
 *
 * Its own chunk with livekit-client: StreamPlayerLazy.tsx loads it.
 */
export default function StreamPlayer({ base, stream, mx }: { base: string; stream: PublicStream; mx?: MatrixClient }) {
  if (stream.state === 'ended') {
    return stream.replay ? (
      <div className="nu-stream-player" data-nu-role="stream-player">
        <video
          className="nu-stream-player__video"
          data-nu-role="stream-replay"
          src={`${base}${stream.replay.url}`}
          controls
          playsInline
          preload="metadata"
          poster={stream.thumbnail ? `${base}${stream.thumbnail}` : undefined}
        />
      </div>
    ) : (
      <div className="nu-stream-player nu-stream-player--empty" data-nu-role="stream-player">
        <p>This stream has ended.</p>
      </div>
    );
  }
  return <LivePlayer base={base} stream={stream} mx={mx} />;
}

function LivePlayer({ base, stream, mx }: { base: string; stream: PublicStream; mx?: MatrixClient }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room>();
  const identityRef = useRef<string>();
  const leavingRef = useRef(false);
  const idleRef = useRef<number>();
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'playing'>('idle');
  const [error, setError] = useState<string>();
  const [audioOnly, setAudioOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const soundRef = useRef({ muted, volume });
  soundRef.current = { muted, volume };

  useEffect(
    () => () => {
      leavingRef.current = true;
      window.clearTimeout(idleRef.current);
      void roomRef.current?.disconnect();
    },
    []
  );

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    audioRef.current?.querySelectorAll('audio').forEach((element) => {
      element.muted = muted;
      element.volume = volume;
    });
  }, [muted, volume]);

  const play = async (resuming = false) => {
    setError(undefined);
    setPhase('connecting');
    try {
      const { token, url, identity } = await viewerToken(base, stream.id, mx, resuming ? identityRef.current : undefined);
      identityRef.current = identity;
      const room = new Room(VIEWER_ROOM_OPTIONS);
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Video && videoRef.current) {
          track.attach(videoRef.current);
          setHasVideo(true);
        } else if (track.kind === Track.Kind.Audio && audioRef.current) {
          const element = track.attach();
          element.muted = soundRef.current.muted;
          element.volume = soundRef.current.volume;
          audioRef.current.append(element);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((element) => element !== videoRef.current && element.remove());
        if (track.kind === Track.Kind.Video) setHasVideo(false);
      });
      room.on(RoomEvent.Disconnected, () => {
        if (leavingRef.current || roomRef.current !== room) return;
        setPhase('idle');
        setHasVideo(false);
        // LiveKit has already tried to reconnect by itself; once, with a fresh token, as the same viewer.
        if (!resuming) void play(true);
        else setError('The stream was interrupted. Press play to watch again.');
      });
      await room.connect(url, token);
      await room.startAudio().catch(() => undefined);
      setPhase('playing');
      wake();
    } catch (err) {
      setPhase('idle');
      setError(err instanceof StreamError ? refusalText(err) : 'Couldn’t connect to the stream. Try again in a moment.');
    }
  };

  /** Pausing a live stream leaves it, so nothing is sent while paused; play joins again at the live edge. */
  const pause = () => {
    const room = roomRef.current;
    roomRef.current = undefined;
    setPhase('idle');
    setHasVideo(false);
    void room?.disconnect();
  };

  const toggleAudioOnly = () => {
    const next = !audioOnly;
    setAudioOnly(next);
    roomRef.current?.remoteParticipants.forEach((participant) =>
      participant.videoTrackPublications.forEach((publication) => publication.setSubscribed(!next))
    );
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void boxRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    setMuted(value === 0);
  };

  const toggleMuted = () => {
    if (!silent) return setMuted(true);
    setMuted(false);
    if (volume === 0) setVolume(1);
  };

  /** The controls hide after 3 s without the mouse moving, while the stream plays. */
  const wake = () => {
    setIdle(false);
    window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(() => setIdle(true), 3000);
  };

  const silent = muted || volume === 0;
  return (
    <div
      ref={boxRef}
      className="nu-stream-player"
      data-nu-role="stream-player"
      data-nu-phase={phase}
      data-nu-idle={phase === 'playing' && idle ? 'true' : undefined}
      onMouseMove={wake}
      onMouseLeave={() => setIdle(true)}
    >
      <video
        ref={videoRef}
        className="nu-stream-player__video"
        data-nu-role="stream-video"
        playsInline
        muted
        hidden={phase !== 'playing' || audioOnly}
        onDoubleClick={toggleFullscreen}
      />
      <div ref={audioRef} hidden />
      {phase !== 'playing' && (
        <button
          type="button"
          className="nu-stream-player__start"
          data-nu-role="stream-play"
          disabled={phase === 'connecting'}
          onClick={() => void play()}
          style={stream.thumbnail ? { backgroundImage: `url("${base}${stream.thumbnail}")` } : undefined}
        >
          <span className="nu-stream-player__play">
            <Icon name="play" size={28} />
          </span>
          <span className="nu-stream-player__label">{phase === 'connecting' ? 'Connecting…' : 'Watch live'}</span>
        </button>
      )}
      {phase === 'playing' && audioOnly && <div className="nu-stream-player__audio-only">Listening only. The video is off to save data.</div>}
      {phase === 'playing' && !audioOnly && !hasVideo && <div className="nu-stream-player__audio-only">Waiting for the picture…</div>}
      {phase === 'playing' && (
        <div className="nu-stream-player__controls" data-nu-role="stream-controls">
          <button type="button" onClick={pause} title="Pause" aria-label="Pause" data-nu-role="stream-pause">
            <Icon name="pause" size={20} />
          </button>
          <button type="button" onClick={toggleMuted} title={silent ? 'Unmute' : 'Mute'} aria-label={silent ? 'Unmute' : 'Mute'} aria-pressed={silent} data-nu-role="stream-mute">
            <Icon name={silent ? 'volumeOff' : 'volume'} size={20} />
          </button>
          <input
            type="range"
            className="nu-stream-player__volume"
            min={0}
            max={1}
            step={0.05}
            value={silent ? 0 : volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            aria-label="Volume"
            data-nu-role="stream-volume"
          />
          <span className="nu-stream-player__live">
            <span className="nu-stream-player__live-dot" />
            LIVE
          </span>
          <span className="nu-stream-player__spacer" />
          <button type="button" onClick={toggleAudioOnly} aria-pressed={audioOnly} data-nu-role="stream-audio-only">
            <Icon name="headphones" size={18} />
            <span>{audioOnly ? 'Show video' : 'Audio only'}</span>
          </button>
          <button type="button" onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} data-nu-role="stream-fullscreen">
            <Icon name={fullscreen ? 'minimize' : 'maximize'} size={20} />
          </button>
        </div>
      )}
      {error && (
        <p className="nu-stream-player__error" role="alert" data-nu-role="stream-error">
          {error}
        </p>
      )}
    </div>
  );
}
