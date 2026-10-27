/**
 * The pure parts of the go-live setup page and the streamer's dashboard (docs/streaming.md, "The
 * dashboard"): reading WebRTC stats, the running timeouts, thumbnails' size, what OBS is told.
 */

export const TITLE_MAX = 120;

/** A title the server takes: 1 to 120 characters once trimmed. */
export function titleOk(title: string): boolean {
  const t = title.trim();
  return t.length >= 1 && t.length <= TITLE_MAX;
}

/** The timeouts the dashboard offers on a chat message, in minutes. */
export const TIMEOUT_MINUTES = [1, 5, 10, 60] as const;

export const OBS_SETTINGS = [
  'Resolution 1280×720 or 1920×1080, 30 fps.',
  'Video bitrate 3000 to 4500 kbps, keyframe interval 2 s, B-frames off.',
  'Audio is Opus, which is OBS’s default for WHIP.',
] as const;

export const OBS_BITRATE_NOTE =
  'OBS’s picture goes to every viewer as it is, with no smaller version to fall back on. A higher bitrate means fewer people can watch before this server’s upload runs out: at 4500 kbps about a third as many as the usual 720p.';

/** "pk_abcd…wxyz" as dots: the key is hidden until Show is pressed. */
export function maskKey(key: string): string {
  return '•'.repeat(Math.min(Math.max(key.length, 8), 32));
}

/** Where the crop of a picture goes in a box of another shape: the whole box filled, centred. */
export function coverRect(sw: number, sh: number, tw: number, th: number): { sx: number; sy: number; sWidth: number; sHeight: number } {
  if (sw <= 0 || sh <= 0) return { sx: 0, sy: 0, sWidth: sw, sHeight: sh };
  const scale = Math.max(tw / sw, th / sh);
  const sWidth = tw / scale;
  const sHeight = th / scale;
  return { sx: (sw - sWidth) / 2, sy: (sh - sHeight) / 2, sWidth, sHeight };
}

export type VideoStats = { width: number; height: number; fps: number; bytes: number; at: number };

export type StatEntry = { type?: string; kind?: string; mediaType?: string; frameWidth?: number; frameHeight?: number; framesPerSecond?: number; bytesSent?: number; bytesReceived?: number; timestamp?: number };

/**
 * The video's size, frame rate and byte count out of a WebRTC stats report: the streamer's own
 * (`outbound-rtp`; simulcast or SVC send several, the biggest counts and bytes are added up) or a
 * received one (`inbound-rtp`).
 */
export function readVideoStats(entries: Iterable<StatEntry>): VideoStats | undefined {
  let best: VideoStats | undefined;
  let bytes = 0;
  let any = false;
  for (const e of entries) {
    if (e.type !== 'outbound-rtp' && e.type !== 'inbound-rtp') continue;
    if ((e.kind ?? e.mediaType) !== 'video') continue;
    any = true;
    bytes += e.type === 'outbound-rtp' ? (e.bytesSent ?? 0) : (e.bytesReceived ?? 0);
    const width = e.frameWidth ?? 0;
    if (!best || width > best.width) best = { width, height: e.frameHeight ?? 0, fps: e.framesPerSecond ?? 0, bytes: 0, at: e.timestamp ?? 0 };
  }
  return any && best ? { ...best, bytes } : undefined;
}

/** Kilobits a second between two readings, or undefined when they can't be compared. */
export function bitrateKbps(prev: VideoStats | undefined, next: VideoStats): number | undefined {
  if (!prev || next.at <= prev.at || next.bytes < prev.bytes) return undefined;
  return Math.round(((next.bytes - prev.bytes) * 8) / (next.at - prev.at));
}

export type Health = { width: number; height: number; fps: number; kbps?: number };

/** "1280×720 · 30 fps · 2400 kbps", with what isn't known left out. */
export function describeHealth(health: Health | undefined): string {
  if (!health || !health.width) return 'No picture yet';
  const parts = [`${health.width}×${health.height}`, `${Math.round(health.fps)} fps`];
  if (health.kbps !== undefined) parts.push(health.kbps >= 1000 ? `${(health.kbps / 1000).toFixed(1)} Mbps` : `${health.kbps} kbps`);
  return parts.join(' · ');
}

export type RunningTimeout = { user: string; until: number; minutesLeft: number };

/** The timeouts still running, soonest to end first. */
export function runningTimeouts(timeouts: Record<string, number>, now: number): RunningTimeout[] {
  return Object.entries(timeouts)
    .filter(([, until]) => until > now)
    .map(([user, until]) => ({ user, until, minutesLeft: Math.max(1, Math.ceil((until - now) / 60_000)) }))
    .sort((a, b) => a.until - b.until);
}

export function timeoutLabel(minutes: number): string {
  return minutes === 60 ? '1 hour' : minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
