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
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room>();
  const identityRef = useRef<string>();
  const leavingRef = useRef(false);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'playing'>('idle');
  const [error, setError] = useState<string>();
  const [audioOnly, setAudioOnly] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(
    () => () => {
      leavingRef.current = true;
      void roomRef.current?.disconnect();
    },
    []
  );

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
          audioRef.current.append(track.attach());
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
    } catch (err) {
      setPhase('idle');
      setError(err instanceof StreamError ? refusalText(err) : 'Couldn’t connect to the stream. Try again in a moment.');
    }
  };

  const toggleAudioOnly = () => {
    const next = !audioOnly;
    setAudioOnly(next);
    roomRef.current?.remoteParticipants.forEach((participant) =>
      participant.videoTrackPublications.forEach((publication) => publication.setSubscribed(!next))
    );
  };

  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    audioRef.current?.querySelectorAll('audio').forEach((element) => (element.muted = next));
  };

  return (
    <div className="nu-stream-player" data-nu-role="stream-player" data-nu-phase={phase}>
      <video ref={videoRef} className="nu-stream-player__video" data-nu-role="stream-video" playsInline muted hidden={phase !== 'playing' || audioOnly} />
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
        <div className="nu-stream-player__controls">
          <button type="button" onClick={toggleMuted} aria-pressed={muted} title={muted ? 'Unmute' : 'Mute'} data-nu-role="stream-mute">
            <Icon name={muted ? 'headphonesOff' : 'headphones'} size={16} />
          </button>
          <button type="button" onClick={toggleAudioOnly} aria-pressed={audioOnly} data-nu-role="stream-audio-only">
            {audioOnly ? 'Show video' : 'Audio only'}
          </button>
          <button type="button" title="Full screen" onClick={() => void videoRef.current?.requestFullscreen?.().catch(() => undefined)} disabled={audioOnly}>
            <Icon name="monitor" size={16} />
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
