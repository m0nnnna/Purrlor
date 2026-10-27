import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TrackSource, type VideoGrant } from 'livekit-server-sdk';
import type { RawEvent } from './publicWeb.js';

/**
 * Live streams (docs/streaming.md): the pure rules, unit-tested in streams.test.ts. streamRoutes.ts
 * does the HTTP, LiveKit and the chat room; recordings.ts the replays.
 */

/** The pointer an owner's app writes in their profile room while they're live. */
export const LIVE_STREAM_EVENT = 'xyz.nekous.live_stream';
/** State in a stream's chat room saying which stream it belongs to. */
export const STREAM_CHAT_EVENT = 'xyz.nekous.stream_chat';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A stream nobody ever said was live is forgotten after this. */
export const STARTING_TIMEOUT_MS = 10 * MINUTE;
/** How long a streamer may be out of the room (a closed tab, a lost connection) before it ends. */
export const STREAMER_AWAY_MS = 2 * MINUTE;
/** A viewer token is only for joining; tokens given this recently count toward the cap until used. */
export const VIEWER_TOKEN_TTL_S = 5 * 60;
export const PENDING_VIEWER_MS = 30_000;
/** What one viewer at 720p costs (VP9), in Mbps; the cap is sized from it. */
export const MBPS_PER_VIEWER = 1.6;
/** The share of the server's upload streams may use; the rest is for voice, the site and federation. */
export const UPLINK_SHARE = 0.7;
export const MAX_TITLE = 120;

export type StreamState = 'starting' | 'live' | 'ended';
export type Replay = { bytes: number; durationMs: number };

export type StreamRecord = {
  id: string;
  owner: string;
  title: string;
  state: StreamState;
  createdAt: number;
  liveAt: number | null;
  endedAt: number | null;
  chatRoom: string | null;
  egressId: string | null;
  replay: Replay | null;
  expiresAt: number | null;
};

export type StreamSettings = {
  enabled: boolean;
  viewerCap: number;
  guestCap: number;
  maxLive: number;
  maxMs: number;
  replayMs: number;
};

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The settings from `.env` (docs/streaming.md, "Admins"). */
export function streamSettings(env: Record<string, string | undefined>): StreamSettings {
  const uplink = positive(env.STREAM_UPLINK_MBPS, 100);
  const explicit = env.STREAM_VIEWER_CAP?.trim();
  const viewerCap = explicit && /^\d{1,6}$/.test(explicit) ? Number(explicit) : Math.floor((UPLINK_SHARE * uplink) / MBPS_PER_VIEWER);
  return {
    enabled: (env.STREAMING ?? 'on').trim().toLowerCase() !== 'off',
    viewerCap,
    guestCap: Math.floor(viewerCap / 2),
    maxLive: Math.floor(positive(env.STREAM_MAX_LIVE, 2)),
    maxMs: positive(env.STREAM_MAX_HOURS, 12) * HOUR,
    replayMs: positive(env.STREAM_REPLAY_HOURS, 72) * HOUR,
  };
}

const ID = /^[A-Za-z0-9_-]{16}$/;

/** 16 characters from [A-Za-z0-9_-]: 96 random bits. */
export function newStreamId(random: (n: number) => Buffer = randomBytes): string {
  return random(12).toString('base64url');
}

export function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * Control characters, zero-width ones, and the direction overrides that can disguise text. Built
 * from code points so the source stays plain ASCII.
 */
const UNSAFE_CHARACTERS = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join('')}]`,
  'g'
);

/** A title as typed → one line of plain text, 1 to 120 characters, or undefined. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length === 0 || chars.length > MAX_TITLE) return undefined;
  return text;
}

/** Stream rooms are named apart from voice channels' (`matrix-…`, livekitRoomName.ts). */
export function streamRoomName(id: string): string {
  return `stream-${id}`;
}

/** A signed-out viewer's LiveKit identity. Matrix IDs start with `@`, so the two never meet. */
export function guestIdentity(random: (n: number) => Buffer = randomBytes): string {
  return `guest-${random(12).toString('base64url')}`;
}

export function isGuestIdentity(identity: string): boolean {
  return identity.startsWith('guest-');
}

/**
 * The streamer: sends their screen, its sound and their microphone. `canSubscribe` stays on: without
 * it LiveKit never brings up the connection that clients wait for, and joining times out. Nobody
 * else in a stream room sends anything, so there is nothing to receive anyway.
 */
export function streamerGrant(room: string): VideoGrant {
  return {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  };
}

/**
 * A viewer: receives, sends nothing. `hidden` keeps them out of everyone's participant list, so a
 * viewer joining isn't a message to every other viewer; the count comes from the token server.
 */
export function viewerGrant(room: string): VideoGrant {
  return { room, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, canUpdateOwnMetadata: false, hidden: true };
}

/** Someone in a stream's LiveKit room, as the cap sees them. */
export type RoomPerson = { identity: string; recorder: boolean };

export type ViewerCount = { total: number; guests: number };

/**
 * Viewers across every stream on this server: everyone in a stream room except its streamer and
 * recorders, plus tokens given in the last 30 s to identities not in a room yet (so a burst of
 * people pressing play at once can't all slip under the cap).
 */
export function countViewers(
  rooms: { owner: string; people: RoomPerson[] }[],
  pending: { identity: string; at: number }[],
  now: number
): ViewerCount {
  const present = new Set<string>();
  for (const room of rooms) {
    for (const person of room.people) if (!person.recorder && person.identity !== room.owner) present.add(person.identity);
  }
  for (const token of pending) if (now - token.at < PENDING_VIEWER_MS) present.add(token.identity);
  let guests = 0;
  for (const identity of present) if (isGuestIdentity(identity)) guests += 1;
  return { total: present.size, guests };
}

/** Whether one more viewer may join. Someone already counted (a reconnect) always may. */
export function admitViewer(count: ViewerCount, settings: StreamSettings, guest: boolean, alreadyCounted: boolean): 'ok' | 'stream_full' | 'guest_full' {
  if (alreadyCounted) return 'ok';
  if (count.total >= settings.viewerCap) return 'stream_full';
  if (guest && count.guests >= settings.guestCap) return 'guest_full';
  return 'ok';
}

/**
 * What the regular sweep should do with a stream now: forget one that never went live, end one
 * that ran too long or whose streamer has been gone too long, or delete one whose replay expired.
 * `streamerSeenAt` is when the sweep last saw the streamer in the room.
 */
export function dueAction(record: StreamRecord, now: number, settings: StreamSettings, streamerSeenAt: number | undefined): 'drop' | 'end' | 'expire' | undefined {
  if (record.state === 'starting') return now - record.createdAt >= STARTING_TIMEOUT_MS ? 'drop' : undefined;
  if (record.state === 'live') {
    const liveAt = record.liveAt ?? record.createdAt;
    if (now - liveAt >= settings.maxMs) return 'end';
    if (now - Math.max(streamerSeenAt ?? liveAt, liveAt) >= STREAMER_AWAY_MS) return 'end';
    return undefined;
  }
  return record.expiresAt !== null && now >= record.expiresAt ? 'expire' : undefined;
}

export function endedRecord(record: StreamRecord, now: number, settings: StreamSettings): StreamRecord {
  return { ...record, state: 'ended', endedAt: now, expiresAt: now + settings.replayMs };
}

/** Whether anyone but the streamer may see it: live, or ended with its replay time left. */
export function isPublic(record: StreamRecord, now: number): boolean {
  if (record.state === 'live') return true;
  return record.state === 'ended' && record.expiresAt !== null && now < record.expiresAt;
}

export type PublicStream = {
  id: string;
  owner: string;
  title: string;
  state: StreamState;
  liveAt: number | null;
  endedAt: number | null;
  viewers?: number;
  chatRoom: string | null;
  thumbnail: string | null;
  replay: { durationMs: number; url: string } | null;
  /** Ended, and Egress is still finishing the replay's file. */
  saving: boolean;
  expiresAt: number | null;
};

/** The answer's shape (docs/streaming.md, `GET /api/public/streams/:id`). */
export function publicStream(record: StreamRecord, extra: { viewers?: number; hasThumbnail: boolean }): PublicStream {
  const base = `/api/public/streams/${record.id}`;
  return {
    id: record.id,
    owner: record.owner,
    title: record.title,
    state: record.state,
    liveAt: record.liveAt,
    endedAt: record.endedAt,
    ...(record.state === 'live' && { viewers: extra.viewers ?? 0 }),
    chatRoom: record.chatRoom,
    thumbnail: extra.hasThumbnail ? `${base}/thumbnail` : null,
    replay: record.replay ? { durationMs: record.replay.durationMs, url: `${base}/replay` } : null,
    saving: record.state === 'ended' && !record.replay && record.egressId !== null,
    expiresAt: record.expiresAt,
  };
}

/** `GET /api/public/streams`: live ones and unexpired replays, newest first, at most 20. */
export function streamListing(records: Iterable<StreamRecord>, now: number, owner?: string): StreamRecord[] {
  return [...records]
    .filter((record) => isPublic(record, now) && (owner === undefined || record.owner === owner))
    .sort((a, b) => (b.liveAt ?? b.createdAt) - (a.liveAt ?? a.createdAt))
    .slice(0, 20);
}

/** The chat room's power levels: the bot runs it, the streamer moderates, everyone else talks. */
export function chatPowerLevels(botId: string, owner: string): Record<string, unknown> {
  return {
    users: { [botId]: 100, [owner]: 50 },
    users_default: 0,
    events_default: 0,
    state_default: 100,
    redact: 50,
    kick: 50,
    ban: 50,
    invite: 100,
    events: { 'm.room.name': 100, 'm.room.topic': 100, 'm.room.power_levels': 100, 'm.room.join_rules': 100 },
  };
}

export type ChatMessage = { id: string; ts: number; sender: string; body: string };

/** Plain text messages out of a chat room's events, oldest first; deleted and other events left out. */
export function chatMessages(events: RawEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const event of events) {
    if (event.type !== 'm.room.message' || typeof event.event_id !== 'string' || typeof event.sender !== 'string') continue;
    const content = event.content ?? {};
    if (content.msgtype !== 'm.text' && content.msgtype !== 'm.emote') continue;
    if (typeof content.body !== 'string' || !content.body.trim()) continue;
    // An edit is its own event; the original stands for the message.
    const relates = content['m.relates_to'] as { rel_type?: unknown } | undefined;
    if (relates?.rel_type === 'm.replace') continue;
    const body = content.msgtype === 'm.emote' ? `* ${content.body}` : content.body;
    out.push({ id: event.event_id, ts: Number(event.origin_server_ts) || 0, sender: event.sender, body: body.slice(0, 2000) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The chat log file: one message a line. */
export function chatLogText(messages: ChatMessage[]): string {
  return messages.map((m) => JSON.stringify({ ts: m.ts, sender: m.sender, body: m.body })).join('\n') + (messages.length ? '\n' : '');
}

export type DownloadKind = 'replay' | 'chat';

/** A download address's signature: the stream, what, and until when, under a key made each start. */
export function downloadSignature(secret: Buffer, id: string, kind: DownloadKind, expires: number): string {
  return createHmac('sha256', secret).update(`${id}\n${kind}\n${expires}`).digest('base64url');
}

export function downloadAllowed(secret: Buffer, id: string, kind: DownloadKind, expires: unknown, signature: unknown, now: number): boolean {
  const until = Number(expires);
  if (!Number.isSafeInteger(until) || until < now || typeof signature !== 'string') return false;
  const expected = Buffer.from(downloadSignature(secret, id, kind, until));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** An `Authorization: OpenID <access_token> <matrix_server_name>` header, for the thumbnail upload. */
export function openIdFromHeader(header: unknown): { access_token: string; matrix_server_name: string } | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^OpenID ([^\s]{1,2048}) ([^\s]{1,255})$/.exec(header.trim());
  return match ? { access_token: match[1], matrix_server_name: match[2] } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const nullableString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** One stored record, checked; anything unreadable is dropped rather than trusted. */
export function parseStreamRecord(raw: unknown): StreamRecord | undefined {
  if (!isRecord(raw) || !isStreamId(raw.id) || typeof raw.owner !== 'string' || typeof raw.title !== 'string') return undefined;
  if (raw.state !== 'starting' && raw.state !== 'live' && raw.state !== 'ended') return undefined;
  const createdAt = nullableNumber(raw.createdAt);
  if (createdAt === null) return undefined;
  const replay = isRecord(raw.replay) && typeof raw.replay.bytes === 'number' && typeof raw.replay.durationMs === 'number' ? { bytes: raw.replay.bytes, durationMs: raw.replay.durationMs } : null;
  return {
    id: raw.id,
    owner: raw.owner,
    title: raw.title,
    state: raw.state,
    createdAt,
    liveAt: nullableNumber(raw.liveAt),
    endedAt: nullableNumber(raw.endedAt),
    chatRoom: nullableString(raw.chatRoom),
    egressId: nullableString(raw.egressId),
    replay,
    expiresAt: nullableNumber(raw.expiresAt),
  };
}

/** Every stream record, in memory and in `/data/streams.json` (written whole on each change). */
export class StreamStore {
  private records = new Map<string, StreamRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const list = isRecord(raw) && Array.isArray(raw.streams) ? raw.streams : [];
      for (const item of list) {
        const record = parseStreamRecord(item);
        if (record) this.records.set(record.id, record);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Streams not read from ${this.file}`, err);
    }
  }

  get(id: string): StreamRecord | undefined {
    return this.records.get(id);
  }

  all(): StreamRecord[] {
    return [...this.records.values()];
  }

  async put(record: StreamRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (this.records.delete(id)) await this.save();
  }

  /** Writes queue behind each other, so the file is always one whole state. */
  private save(): Promise<void> {
    const text = JSON.stringify({ streams: this.all() }, null, 1);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
