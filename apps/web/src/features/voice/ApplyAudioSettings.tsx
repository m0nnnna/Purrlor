import { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, type LocalAudioTrack } from 'livekit-client';
import { audioCaptureOptions, deviceIdOrDefault, useAudioSettings } from './audioSettings';
import { applyCallVolumes } from './callVolume';

/**
 * Applies changes to Settings → Voice & Audio to the call in progress, without rejoining it. The
 * call opens with the settings as they were (ActiveVoiceCall's room options); this picks up
 * anything changed after that. Renders nothing; lives inside LiveKitRoom.
 */
export function ApplyAudioSettings() {
  const room = useRoomContext();
  const settings = useAudioSettings();
  const applied = useRef(settings);

  // The microphone: a new device or different voice processing reopens it with the new settings.
  // A mic that's muted still has its track, so it's reopened too, ready for unmuting.
  useEffect(() => {
    const before = applied.current;
    if (
      before.inputDeviceId === settings.inputDeviceId &&
      before.echoCancellation === settings.echoCancellation &&
      before.noiseSuppression === settings.noiseSuppression &&
      before.autoGainControl === settings.autoGainControl
    ) {
      return;
    }
    const capture = { ...audioCaptureOptions(settings), deviceId: deviceIdOrDefault(settings.inputDeviceId) };
    // Also what the mic opens with if it's turned on for the first time later in this call.
    room.options.audioCaptureDefaults = capture;
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    mic?.restartTrack(capture).catch((err: unknown) => console.warn('[voice] couldn’t reopen the microphone', err));
  }, [room, settings]);

  useEffect(() => {
    if (applied.current.outputDeviceId === settings.outputDeviceId) return;
    room
      .switchActiveDevice('audiooutput', deviceIdOrDefault(settings.outputDeviceId))
      .catch((err: unknown) => console.warn('[voice] couldn’t switch speakers', err));
  }, [room, settings.outputDeviceId]);

  useEffect(() => {
    applyCallVolumes(room);
  }, [room, settings.outputVolume]);

  // Runs after the effects above, so each compares against what was applied before this change.
  useEffect(() => {
    applied.current = settings;
  }, [settings]);

  // Someone joining (or a track arriving) plays at your overall volume and their own level.
  useEffect(() => {
    const apply = () => applyCallVolumes(room);
    room.on(RoomEvent.ParticipantConnected, apply).on(RoomEvent.TrackSubscribed, apply);
    return () => {
      room.off(RoomEvent.ParticipantConnected, apply).off(RoomEvent.TrackSubscribed, apply);
    };
  }, [room]);

  return null;
}
