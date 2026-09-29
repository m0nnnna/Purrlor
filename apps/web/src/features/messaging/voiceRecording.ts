/** Codecs tried in order for MediaRecorder — Ogg/Opus first since that's what MSC3245 examples
 *  and Element itself record, falling back to WebM/Opus (Chrome doesn't support recording Ogg
 *  directly) and finally whatever the browser happens to support at all. */
const CANDIDATE_MIME_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/**
 * Picks the best MediaRecorder mime type this browser supports, trying MSC3245's preferred
 * Ogg/Opus first. Takes the support check as a parameter (rather than calling
 * `MediaRecorder.isTypeSupported` itself) so the selection logic is a pure function that's cheap
 * to unit test without a real MediaRecorder/browser.
 *
 * Returns `undefined` when nothing in the candidate list is supported — MediaRecorder is still
 * usable at that point, just without an explicit `mimeType` (the browser picks its own default).
 */
export function pickRecordingMimeType(isSupported: (mimeType: string) => boolean): string | undefined {
  return CANDIDATE_MIME_TYPES.find(isSupported);
}

/** Renders elapsed recording time as Discord/Element's compact "m:ss" (no leading zero on
 *  minutes, but seconds always zero-padded) — used by the composer's recording bar and capped
 *  at MAX_RECORDING_MS so it never has to show hours. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Hard cap on a single voice-message recording. */
export const MAX_RECORDING_MS = 15 * 60 * 1000;
