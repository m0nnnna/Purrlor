import { MsgType } from 'matrix-js-sdk';
import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';

/** Same shape upload.ts already uses for images/files/video: either a plain `url` (unencrypted
 *  room) or an encrypted-attachment `file` descriptor (E2EE room). */
export type VoiceMessageLocation = { url: string } | { file: EncryptedAttachmentInfo & { url: string } };

export type BuildVoiceMessageContentParams = {
  location: VoiceMessageLocation;
  mimetype: string;
  size: number;
  /** Recording length in milliseconds — goes in both `info.duration` (the plain `m.audio` field
   *  every client understands) and the MSC1767 extensible-event block. */
  durationMs: number;
  /** ~100 integers, 0–1024 — see waveform.ts. */
  waveform: number[];
};

/**
 * Builds an `m.audio` event content for a recorded voice message: the plain MSC2854-era fields
 * every client (including ones with no voice-message support at all) can already render, plus
 * the two MSC3245-era extensible-event blocks that mark it as a voice message and carry the
 * waveform — the same combination Element sends, which is what makes this interoperable with it.
 *
 * Pure and synchronous on purpose (no MatrixClient/upload dependency) so it's cheap to unit test
 * independently of the actual recording/upload flow in matrix/upload.ts.
 */
export function buildVoiceMessageContent({
  location,
  mimetype,
  size,
  durationMs,
  waveform,
}: BuildVoiceMessageContentParams): Record<string, unknown> {
  return {
    msgtype: MsgType.Audio,
    // Element's own placeholder body for voice messages — there's no user-authored caption to
    // show, and legacy clients that don't understand msc3245.voice render this as the message.
    body: 'Voice message',
    ...location,
    info: { mimetype, size, duration: durationMs },
    'org.matrix.msc1767.audio': { duration: durationMs, waveform },
    'org.matrix.msc3245.voice': {},
  };
}
