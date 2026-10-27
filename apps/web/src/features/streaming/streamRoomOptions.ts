import { AudioPresets, type RoomOptions, type ScreenShareCaptureOptions, type TrackPublishOptions } from 'livekit-client';
import { SCREEN_SHARE_AUDIO_OPTIONS } from '../voice/voiceChannelRoomOptions';

/**
 * A live stream's encoding (docs/streaming.md, "The stream's encoding"), kept apart from voice's
 * screen share (voiceChannelRoomOptions.ts), which stays at 1080p60 for a few people in a call.
 * Every viewer of a stream is upload from the streamer's server, so this is what keeps it small.
 */

/** 720p at 30 fps, and no more: streams have no frame-rate option. `motion` keeps the frame rate and gives up sharpness first. */
export function streamCaptureOptions(includeSystemAudio: boolean): ScreenShareCaptureOptions {
  return {
    audio: SCREEN_SHARE_AUDIO_OPTIONS,
    resolution: { width: 1280, height: 720, frameRate: 30 },
    contentHint: 'motion',
    systemAudio: includeSystemAudio ? 'include' : 'exclude',
  };
}

/**
 * VP9 with SVC: one stream holding 720p, 360p and 180p layers, which LiveKit hands out per viewer
 * without re-encoding. A browser that can't send it falls back to VP8 with simulcast. Sound is
 * Opus stereo at about 96 kbps.
 */
export const STREAM_PUBLISH_OPTIONS: TrackPublishOptions = {
  videoCodec: 'vp9',
  scalabilityMode: 'L3T3_KEY',
  backupCodec: { codec: 'vp8' },
  screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
  degradationPreference: 'maintain-framerate',
  audioPreset: AudioPresets.musicHighQualityStereo,
  forceStereo: true,
  dtx: false,
  red: false,
};

/** The streamer: dynacast, so layers nobody is watching aren't encoded. */
export const STREAMER_ROOM_OPTIONS: RoomOptions = { dynacast: true, adaptiveStream: false };

/** A viewer: adaptive stream, the layer that fits the player, and none while it isn't seen. */
export const VIEWER_ROOM_OPTIONS: RoomOptions = { adaptiveStream: true, dynacast: true };
