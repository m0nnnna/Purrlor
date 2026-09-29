import { useEffect, useRef, useState } from 'react';
import { ConnectionQuality, Track, type Participant, type RemoteParticipant } from 'livekit-client';
import {
  isTrackReference,
  useConnectionQualityIndicator,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useSpeakingParticipants,
  useTracks,
  VideoTrack,
  type TrackReference,
} from '@livekit/components-react';
import type { Room as MatrixRoom } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { useVoiceCall } from './voiceCallContext';
import { useParticipantSounds } from './useParticipantSounds';
import { usePushToTalk } from './usePushToTalk';
import { SCREEN_SHARE_AUDIO_OPTIONS, setScreenShareJitterBufferTarget } from './voiceChannelRoomOptions';
import { useScreenSharePopout } from './useScreenSharePopout';
import { useSharedWatchTogether } from './watchTogetherContext';
import { sessionMode, type WatchTogetherMode } from './watchTogether';
import { WatchTogetherModal } from './WatchTogetherModal';
import { WatchTogetherPlayer } from './WatchTogetherPlayer';
import '@livekit/components-styles';

// Split out of VoiceChannelPanel.tsx so livekit-client/@livekit/components-react — and everything
// they pull in — load as their own chunk (React.lazy, see VoiceChannelPanel.tsx) only once a call
// actually reaches the "ready" state, instead of shipping in the main bundle for every visitor.

/** LiveKit identities are Matrix user IDs (see services/token-server) — resolve back to a room member for avatar/display name. */
function participantDisplayName(room: MatrixRoom, p: Participant): string {
  return room.getMember(p.identity)?.name || p.name || p.identity;
}

function participantAvatarUrl(room: MatrixRoom, p: Participant): string | null {
  return room.getMember(p.identity)?.getMxcAvatarUrl() ?? null;
}

function connectionQualityBars(quality: ConnectionQuality): number {
  if (quality === ConnectionQuality.Excellent) return 3;
  if (quality === ConnectionQuality.Good) return 2;
  if (quality === ConnectionQuality.Poor) return 1;
  return 0; // Lost/Unknown
}

/** One participant tile — its own component (not inlined in a .map()) because
 *  useConnectionQualityIndicator is a hook and hooks can't run inside a loop callback; this is
 *  the per-item component React's rules require for that. Also owns the local-only "volume for
 *  me" slider (LiveKit's RemoteParticipant.setVolume — client-side only, doesn't affect what
 *  anyone else hears) and the connection-quality bars, both README-flagged as deferred. */
function ParticipantRow({
  room,
  participant,
  speaking,
  cameraTrack,
}: {
  room: MatrixRoom;
  participant: Participant;
  speaking: boolean;
  cameraTrack?: TrackReference;
}) {
  const { quality } = useConnectionQualityIndicator({ participant });
  const bars = connectionQualityBars(quality);
  const [volume, setVolume] = useState(1);
  const name = participantDisplayName(room, participant);

  const handleVolumeChange = (value: number) => {
    setVolume(value);
    (participant as RemoteParticipant).setVolume(value);
  };

  if (cameraTrack) {
    return (
      <li
        className={
          speaking
            ? 'nu-voice-participant nu-voice-participant--video nu-voice-participant--speaking'
            : 'nu-voice-participant nu-voice-participant--video'
        }
      >
        <div className="nu-voice-participant__video-tile" data-nu-role="voice-participant-video">
          <VideoTrack trackRef={cameraTrack} />
          <span className="nu-voice-participant__video-name">
            {name}
            {!participant.isMicrophoneEnabled && <span aria-label="Muted" title="Muted">🔇</span>}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className={speaking ? 'nu-voice-participant nu-voice-participant--speaking' : 'nu-voice-participant'}>
      <span className="nu-voice-participant__avatar">
        {speaking && <span className="nu-voice-participant__ring" aria-hidden="true" />}
        <Avatar name={name} mxcUrl={participantAvatarUrl(room, participant)} size={48} />
      </span>
      <span className="nu-voice-participant__name">{name}</span>
      <span
        className="nu-voice-participant__quality"
        data-nu-role="voice-participant-quality"
        title={`Connection: ${quality}`}
      >
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={
              bar <= bars ? 'nu-voice-participant__quality-bar nu-voice-participant__quality-bar--filled' : 'nu-voice-participant__quality-bar'
            }
          />
        ))}
      </span>
      {!participant.isMicrophoneEnabled && (
        <span className="nu-voice-participant__muted" aria-label="Muted" title="Muted">
          🔇
        </span>
      )}
      {participant.attributes.deafened === 'true' && (
        <span className="nu-voice-participant__muted" aria-label="Deafened" title="Deafened">
          🔕
        </span>
      )}
      {!participant.isLocal && (
        <input
          type="range"
          className="nu-voice-participant__volume"
          data-nu-role="voice-participant-volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          title="Volume for me"
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
        />
      )}
    </li>
  );
}

/** The live call UI — participant grid, controls, screen share/Watch Together slot — for a
 *  channel whose call has actually reached the "ready" (connected) state. Loaded lazily by
 *  VoiceChannelPanel via React.lazy, since everything here (and its LiveKit imports above) is
 *  only ever needed once a call is really connected. */
export default function VoiceCallBody({ room, onLeave }: { room: MatrixRoom; onLeave: () => void }) {
  useParticipantSounds();
  const participants = useParticipants();
  const speaking = useSpeakingParticipants();
  const speakingIds = new Set(speaking.map((p) => p.identity));
  const { localParticipant, isMicrophoneEnabled, isScreenShareEnabled, isCameraEnabled } = useLocalParticipant();
  const pushToTalk = usePushToTalk(localParticipant);
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);
  const activeScreenShare = screenShareTracks[0];
  const cameraTracks = useTracks([Track.Source.Camera]).filter(isTrackReference);
  const cameraTrackByIdentity = new Map(cameraTracks.map((t) => [t.participant.identity, t]));
  const call = useVoiceCall();
  const deafened = call?.deafened ?? false;
  const setDeafened = call?.setDeafened ?? (() => {});
  const livekitRoom = useRoomContext();
  const keyframeWorkerRef = useRef<Worker>();
  const screenSharePopout = useScreenSharePopout(activeScreenShare?.publication.track?.mediaStreamTrack);
  // Held at call level (VoiceCallSession), so it outlives this pane — Listen together keeps playing
  // from the Now playing card while you're in another channel.
  const watchTogether = useSharedWatchTogether();
  const sharedMode = watchTogether?.state ? sessionMode(watchTogether.state) : undefined;
  const [watchTogetherModal, setWatchTogetherModal] = useState<WatchTogetherMode | null>(null);

  // Viewer-side only: ask the remote sharer for keyframes periodically and give the decoder a
  // slightly larger jitter buffer, trading a little latency for fewer dropped/stuttered frames.
  useEffect(() => {
    if (!activeScreenShare || activeScreenShare.participant.isLocal) return;
    const mediaStreamTrack = activeScreenShare.publication.track?.mediaStreamTrack;
    if (!mediaStreamTrack) return;
    if (!keyframeWorkerRef.current) {
      keyframeWorkerRef.current = new Worker(new URL('./screenShareKeyframeRequest.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    setScreenShareJitterBufferTarget(livekitRoom, mediaStreamTrack, {
      keyframeRequestWorker: keyframeWorkerRef.current,
    });
  }, [activeScreenShare, livekitRoom]);

  const toggleDeafen = () => {
    const next = !deafened;
    setDeafened(next);
    // LiveKit has no built-in "deafened" concept — broadcast it ourselves via participant
    // attributes so other participants (and the channel-list occupancy view) can show it too.
    localParticipant.setAttributes({ deafened: String(next) });
    if (next && isMicrophoneEnabled) {
      localParticipant.setMicrophoneEnabled(false);
    }
  };

  const toggleMic = () => {
    if (deafened) setDeafened(false);
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  return (
    <>
      {activeScreenShare ? (
        <div className="nu-voice-panel__screen-share" data-nu-role="voice-screen-share">
          {screenSharePopout.isOpen ? (
            <p className="nu-voice-panel__screen-share-popped-out">
              Popped out into its own window.
            </p>
          ) : (
            <VideoTrack trackRef={activeScreenShare} />
          )}
          <button
            type="button"
            className="nu-voice-panel__screen-share-popout"
            data-nu-role="voice-screen-share-popout"
            title={screenSharePopout.isOpen ? 'Bring back' : 'Pop out'}
            onClick={screenSharePopout.toggle}
          >
            {screenSharePopout.isOpen ? '⇱' : '⇲'}
          </button>
        </div>
      ) : (
        // Watch Together only ever shows up here when nobody's actually sharing their screen —
        // screen share always wins the slot if both happen to be active at once, but the watch
        // session itself keeps running in the background (see useWatchTogether.ts) and reappears
        // the moment the screen share stops, rather than being force-stopped by it.
        // Listen together plays from the Now playing card instead, so it has nothing here.
        watchTogether?.state &&
        sharedMode === 'watch' && <WatchTogetherPlayer state={watchTogether.state} controls={watchTogether} />
      )}
      <ul className="nu-voice-participants" data-nu-role="voice-participants">
        {participants.map((p) => (
          <ParticipantRow
            key={p.identity}
            room={room}
            participant={p}
            speaking={speakingIds.has(p.identity)}
            cameraTrack={cameraTrackByIdentity.get(p.identity)}
          />
        ))}
      </ul>
      <div className="nu-voice-controls" data-nu-role="voice-controls">
        <button
          type="button"
          className={
            isMicrophoneEnabled
              ? 'nu-voice-control-button'
              : 'nu-voice-control-button nu-voice-control-button--active'
          }
          onClick={toggleMic}
          disabled={pushToTalk.enabled}
          title={
            pushToTalk.enabled
              ? `Push-to-talk is on — hold ${pushToTalk.keyLabel} to talk`
              : isMicrophoneEnabled
                ? 'Mute'
                : 'Unmute'
          }
        >
          {isMicrophoneEnabled ? '🎤' : '🔇'}
        </button>
        <button
          type="button"
          className={
            pushToTalk.enabled ? 'nu-voice-control-button nu-voice-control-button--active' : 'nu-voice-control-button'
          }
          data-nu-role="voice-ptt-toggle"
          onClick={() => pushToTalk.setEnabled(!pushToTalk.enabled)}
          title={
            pushToTalk.enabled
              ? `Push-to-talk on (hold ${pushToTalk.keyLabel}) — click to switch to open mic`
              : 'Switch to push-to-talk'
          }
        >
          🎙️
        </button>
        {pushToTalk.enabled && (
          <button
            type="button"
            className={
              pushToTalk.rebinding
                ? 'nu-voice-control-button nu-voice-control-button--key nu-voice-control-button--rebinding'
                : 'nu-voice-control-button nu-voice-control-button--key'
            }
            data-nu-role="voice-ptt-rebind"
            onClick={() => (pushToTalk.rebinding ? pushToTalk.cancelRebind() : pushToTalk.startRebind())}
            title={
              pushToTalk.rebinding
                ? 'Press the key you want to hold to talk (Escape to cancel)'
                : `Push-to-talk key: ${pushToTalk.keyLabel} — click to change`
            }
          >
            {pushToTalk.rebinding ? 'Press a key…' : pushToTalk.keyLabel}
          </button>
        )}
        <button
          type="button"
          className={deafened ? 'nu-voice-control-button nu-voice-control-button--active' : 'nu-voice-control-button'}
          onClick={toggleDeafen}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? '🔕' : '🔊'}
        </button>
        <button
          type="button"
          className={
            isCameraEnabled ? 'nu-voice-control-button nu-voice-control-button--active' : 'nu-voice-control-button'
          }
          onClick={() => localParticipant.setCameraEnabled(!isCameraEnabled)}
          title={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraEnabled ? '🎥' : '📷'}
        </button>
        <button
          type="button"
          className={
            isScreenShareEnabled
              ? 'nu-voice-control-button nu-voice-control-button--active'
              : 'nu-voice-control-button'
          }
          onClick={() =>
            localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: SCREEN_SHARE_AUDIO_OPTIONS })
          }
          title={isScreenShareEnabled ? 'Stop sharing' : 'Share screen (browser will offer a "Share audio" option)'}
        >
          🖥️
        </button>
        <button
          type="button"
          className={
            sharedMode === 'watch'
              ? 'nu-voice-control-button nu-voice-control-button--active'
              : 'nu-voice-control-button'
          }
          data-nu-role="voice-watch-together-toggle"
          disabled={!watchTogether}
          onClick={() => setWatchTogetherModal('watch')}
          title={sharedMode === 'watch' ? 'Change what you\'re watching together' : 'Watch a video together'}
        >
          📺
        </button>
        <button
          type="button"
          className={
            sharedMode === 'listen'
              ? 'nu-voice-control-button nu-voice-control-button--active'
              : 'nu-voice-control-button'
          }
          data-nu-role="voice-listen-together-toggle"
          disabled={!watchTogether}
          onClick={() => setWatchTogetherModal('listen')}
          title={sharedMode === 'listen' ? 'Change what you\'re listening to together' : 'Listen to music together'}
        >
          🎵
        </button>
        <button
          type="button"
          className="nu-voice-control-button nu-voice-control-button--leave"
          onClick={onLeave}
          title="Leave"
        >
          📞
        </button>
      </div>
      {watchTogetherModal && watchTogether && (
        <WatchTogetherModal
          initialMode={watchTogetherModal}
          onClose={() => setWatchTogetherModal(null)}
          onStart={(url, mode) => watchTogether.start(url, mode)}
        />
      )}
    </>
  );
}
