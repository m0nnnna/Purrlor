import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isMxc, type RawEvent } from './publicWeb.js';
import { cleanTitle, isStreamId, LIVE_STREAM_EVENT } from './streams.js';

/**
 * WATCH (docs/watch.md): the pure rules, unit-tested in watch.test.ts. Reading video events, the
 * catalogue and its pages, who's live and who has a story, signed play addresses, and view counts.
 * watchRoutes.ts does the HTTP; publicWebRoutes.ts reads the profile rooms this works from.
 */

/** A video: a state event in its owner's profile room, state key = the video's id. */
export const VIDEO_EVENT = 'xyz.nekous.video';
/** A story (docs/stories.md): a timeline event in its owner's profile room. */
export const STORY_EVENT = 'xyz.nekous.story';
export const VIDEO_TYPES: readonly string[] = ['video/mp4', 'video/webm'];

const MiB = 1024 * 1024;
const STORY_MS = 24 * 60 * 60_000;
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_QUERY_WORDS = 10;
const MAX_OWNERS = 2000;
/** Most entries in the `live` and `stories` rows. */
const MAX_ROW = 100;
export const MAX_VIEW_IDS = 100;

const VIDEO_ID = /^[A-Za-z0-9_-]{16}$/;
const EVENT_ID = /^\$[^\s]{1,255}$/;
const USER_ID = /^@[^\s:|,]{1,255}:[^\s|,]{1,255}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export type WatchSettings = { maxBytes: number; maxVideos: number; playTtlS: number };

function positiveInteger(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** The settings from `.env` (docs/watch.md, "Limits"). */
export function watchSettings(env: Record<string, string | undefined>): WatchSettings {
  return {
    maxBytes: positiveInteger(env.WATCH_MAX_BYTES, 500 * MiB),
    maxVideos: positiveInteger(env.WATCH_MAX_VIDEOS, 500),
    playTtlS: positiveInteger(env.WATCH_PLAY_TTL_S, 6 * 60 * 60),
  };
}

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

// --- Reading profile rooms ---------------------------------------------------------------------

export type Video = {
  id: string;
  url: string;
  mimetype: string;
  size: number;
  duration: number;
  w: number;
  h: number;
  title: string;
  description: string;
  thumbnail: string;
  visibility: 'public' | 'private';
  uploaded_at: number;
  /** What comments hang off: the first write's event id (the event's own id on the first write). */
  anchor: string;
};

/**
 * One video from its state event, or undefined: deleted (`{}`), missing a field, another kind of
 * file, or sent by anyone but the owner. Whole numbers only, as events can't hold fractions.
 */
export function parseVideo(event: RawEvent, owner: string): Video | undefined {
  if (event.type !== VIDEO_EVENT || event.sender !== owner || !isVideoId(event.state_key)) return undefined;
  const c = event.content;
  if (!isRecord(c)) return undefined;
  if (!isMxc(c.url) || !isMxc(c.thumbnail) || typeof c.mimetype !== 'string' || !VIDEO_TYPES.includes(c.mimetype)) return undefined;
  if (!whole(c.size, 1) || !whole(c.duration, 1) || !whole(c.w, 1) || !whole(c.h, 1) || !whole(c.uploaded_at, 1)) return undefined;
  if (typeof c.title !== 'string' || !c.title.trim() || [...c.title].length > MAX_TITLE) return undefined;
  if (typeof c.description !== 'string' || [...c.description].length > MAX_DESCRIPTION) return undefined;
  if (c.visibility !== 'public' && c.visibility !== 'private') return undefined;
  // Absent on the first write, when the event's own id is the anchor; every later write names it.
  const anchor = c.anchor === undefined ? event.event_id : c.anchor;
  if (typeof anchor !== 'string' || !EVENT_ID.test(anchor)) return undefined;
  return {
    id: event.state_key,
    url: c.url,
    mimetype: c.mimetype,
    size: c.size,
    duration: c.duration,
    w: c.w,
    h: c.h,
    title: c.title,
    description: c.description,
    thumbnail: c.thumbnail,
    visibility: c.visibility,
    uploaded_at: c.uploaded_at,
    anchor,
  };
}

/** A room's videos, newest `uploaded_at` first, at most `max` of them. */
export function videosFromState(state: RawEvent[], owner: string, max: number): Video[] {
  return state
    .map((event) => parseVideo(event, owner))
    .filter((video): video is Video => !!video)
    .sort((a, b) => b.uploaded_at - a.uploaded_at || (a.id < b.id ? -1 : 1))
    .slice(0, max);
}

/** Ids of the videos deleted (sent again as `{}`) by the owner: their view counts go with them. */
export function deletedVideoIds(state: RawEvent[], owner: string): string[] {
  return state
    .filter((e) => e.type === VIDEO_EVENT && e.sender === owner && isVideoId(e.state_key) && (!isRecord(e.content) || Object.keys(e.content).length === 0))
    .map((e) => e.state_key!);
}

/** The channel's name: the owner's display name in their profile room, if they have one. */
export function channelName(state: RawEvent[], owner: string): string | undefined {
  const member = state.find((e) => e.type === 'm.room.member' && e.state_key === owner);
  const name = member?.content?.displayname;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined;
}

export type LivePointer = { stream_id: string; title: string; started_at: number };

/** The owner's `xyz.nekous.live_stream` pointer (docs/streaming.md), or undefined: `{}` is "not live". */
export function livePointer(state: RawEvent[], owner: string): LivePointer | undefined {
  const event = state.find((e) => e.type === LIVE_STREAM_EVENT && e.state_key === '');
  if (!event || event.sender !== owner || !isRecord(event.content)) return undefined;
  const { stream_id, started_at } = event.content;
  const title = cleanTitle(event.content.title);
  if (!isStreamId(stream_id) || !title || !whole(started_at, 1)) return undefined;
  return { stream_id, title, started_at };
}

export type StorySummary = { latest_ts: number; count: number };

/**
 * Whether the owner has a story up: their `xyz.nekous.story` events under a day old, not redacted
 * (the author's client redacts expired ones; a deletion is a redaction too).
 */
export function storySummary(events: RawEvent[], owner: string, now: number): StorySummary | undefined {
  const seen = new Set<string>();
  let latest = 0;
  for (const event of events) {
    if (event.type !== STORY_EVENT || event.sender !== owner || typeof event.event_id !== 'string' || seen.has(event.event_id)) continue;
    if (event.unsigned?.redacted_because || !isRecord(event.content) || Object.keys(event.content).length === 0) continue;
    const ts = event.origin_server_ts ?? 0;
    if (!(ts > 0) || now - ts >= STORY_MS) continue;
    seen.add(event.event_id);
    latest = Math.max(latest, ts);
  }
  return seen.size ? { latest_ts: latest, count: seen.size } : undefined;
}

// --- The catalogue -----------------------------------------------------------------------------

/** One profile room as the catalogue reads it (publicWebRoutes.ts's ProfileRoom has these). */
export type WatchRoom = { roomId: string; owner: string; name?: string; videos: Video[]; live?: LivePointer; story?: StorySummary };

export type CatalogueVideo = Omit<Video, 'url'> & { owner: string; room_id: string; views?: number; server: string };
export type LiveEntry = LivePointer & { owner: string; server: string };
export type StoryEntry = { owner: string; room_id: string; latest_ts: number; count: number };

export function serverOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

/** A video as the catalogue answers it. The file's address isn't in it: that's what `play` is for. */
export function catalogueVideo(video: Video, owner: string, roomId: string, views: number | undefined): CatalogueVideo {
  const { url: _url, ...fields } = video;
  return { owner, ...fields, room_id: roomId, ...(views !== undefined && { views }), server: serverOf(owner) };
}

type CursorKey = { uploaded_at: number; owner: string; id: string };

/** Newest first; the same time is ordered by owner, then id, so every video has one place. */
function compareVideos(a: CursorKey, b: CursorKey): number {
  return b.uploaded_at - a.uploaded_at || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify([key.uploaded_at, key.owner, key.id])).toString('base64url');
}

export function decodeCursor(cursor: unknown): CursorKey | undefined {
  if (typeof cursor !== 'string' || cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(raw) || raw.length !== 3) return undefined;
    const [uploaded_at, owner, id] = raw as unknown[];
    return whole(uploaded_at, 0) && typeof owner === 'string' && typeof id === 'string' ? { uploaded_at, owner, id } : undefined;
  } catch {
    return undefined;
  }
}

export type CatalogueQuery = { words: string[]; owners?: Set<string>; cursor?: CursorKey; limit: number };

/** The catalogue's body: `q`, `owners`, `cursor`, `limit` (1 to 60, 30 if not a whole number). A bad cursor is the first page. */
export function parseCatalogueQuery(body: unknown): CatalogueQuery {
  const b = isRecord(body) ? body : {};
  const words =
    typeof b.q === 'string'
      ? b.q
          .slice(0, 500)
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, MAX_QUERY_WORDS)
      : [];
  const owners = Array.isArray(b.owners)
    ? new Set(b.owners.slice(0, MAX_OWNERS).filter((owner): owner is string => typeof owner === 'string' && USER_ID.test(owner)))
    : undefined;
  const limit = whole(b.limit, 1) ? Math.min(b.limit, 60) : 30;
  const cursor = decodeCursor(b.cursor);
  return { words, ...(owners && { owners }), ...(cursor && { cursor }), limit };
}

function matches(words: string[], video: Video, owner: string, name: string | undefined): boolean {
  if (!words.length) return true;
  const text = `${video.title}\n${video.description}\n${name ?? ''}\n${owner}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

export type CataloguePage = { videos: CatalogueVideo[]; next?: string; live: LiveEntry[]; stories: StoryEntry[] };

export type CatalogueSources = {
  rooms: Iterable<WatchRoom>;
  /** People left out altogether: hidden, public-off, or hidden by their own instance. */
  excluded(owner: string): boolean;
  /** Taken-down files (`purrlor takedown`): a video whose file is one isn't listed. */
  blocked(url: string): boolean;
  views(owner: string, id: string): number | undefined;
  /** Whether a live pointer may be listed (this server checks its own streams; a peer's are taken as they are). */
  liveOk(owner: string, pointer: LivePointer): boolean;
  maxVideos: number;
};

/** One page of the catalogue (docs/watch.md, `POST /api/public/watch/catalogue`). */
export function cataloguePage(sources: CatalogueSources, query: CatalogueQuery): CataloguePage {
  const rooms = [...sources.rooms].filter((room) => !sources.excluded(room.owner));
  const candidates: { video: Video; room: WatchRoom }[] = [];
  for (const room of rooms) {
    if (query.owners && !query.owners.has(room.owner)) continue;
    for (const video of room.videos.slice(0, sources.maxVideos)) {
      if (sources.blocked(video.url) || !matches(query.words, video, room.owner, room.name)) continue;
      if (query.cursor && compareVideos({ ...video, owner: room.owner }, query.cursor) <= 0) continue;
      candidates.push({ video, room });
    }
  }
  candidates.sort((a, b) => compareVideos({ ...a.video, owner: a.room.owner }, { ...b.video, owner: b.room.owner }));
  const page = candidates.slice(0, query.limit);
  const last = page[page.length - 1];
  const videos = page.map(({ video, room }) => catalogueVideo(video, room.owner, room.roomId, sources.views(room.owner, video.id)));
  const next = candidates.length > query.limit ? { next: encodeCursor({ ...last.video, owner: last.room.owner }) } : {};
  // Who's live and who has a story head the first page only.
  if (query.cursor) return { videos, ...next, live: [], stories: [] };
  const live = rooms
    .filter((room) => room.live && sources.liveOk(room.owner, room.live))
    .map((room) => ({ owner: room.owner, ...room.live!, server: serverOf(room.owner) }))
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, MAX_ROW);
  const stories = rooms
    .filter((room) => room.story)
    .map((room) => ({ owner: room.owner, room_id: room.roomId, ...room.story! }))
    .sort((a, b) => b.latest_ts - a.latest_ts)
    .slice(0, MAX_ROW);
  return { videos, ...next, live, stories };
}

/** `<owner>|<video id>`: how view counts are keyed, in the file and in answers. */
export function viewKey(owner: string, id: string): string {
  return `${owner}|${id}`;
}

export function parseViewKey(key: string): { owner: string; id: string } | undefined {
  const bar = key.lastIndexOf('|');
  const owner = key.slice(0, bar);
  const id = key.slice(bar + 1);
  return bar > 0 && USER_ID.test(owner) && isVideoId(id) ? { owner, id } : undefined;
}

/** A peer's `GET /api/public/watch/views` answer: counts for that peer's own people's videos only. */
export function parsePeerViews(raw: unknown, peerServer: string): Map<string, number> {
  const out = new Map<string, number>();
  const views = isRecord(raw) && isRecord(raw.views) ? raw.views : {};
  for (const [key, n] of Object.entries(views)) {
    const parsed = parseViewKey(key);
    if (parsed && serverOf(parsed.owner) === peerServer && whole(n, 0)) out.set(key, n);
  }
  return out;
}

// --- Play addresses ----------------------------------------------------------------------------

export type PlayGrant = { owner: string; id: string; url: string; expires_at: number };

function playSignature(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * A play token: `<owner>|<video id>|<url>|<expires_at>`, base64url, then `.` and its HMAC-SHA256
 * under the key in `/data/watch-key`, base64url. None of the four can hold a `|`.
 */
export function playToken(key: Buffer, grant: PlayGrant): string {
  const payload = `${grant.owner}|${grant.id}|${grant.url}|${grant.expires_at}`;
  return `${Buffer.from(payload).toString('base64url')}.${playSignature(key, payload).toString('base64url')}`;
}

/** What a play token grants: undefined if it isn't one of ours, `expired` once its time is up. */
export function readPlayToken(key: Buffer, token: unknown, now: number): PlayGrant | 'expired' | undefined {
  if (typeof token !== 'string' || token.length > 2048) return undefined;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return undefined;
  const payload = Buffer.from(match[1], 'base64url').toString('utf8');
  const given = Buffer.from(match[2], 'base64url');
  const expected = playSignature(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const parts = payload.split('|');
  if (parts.length !== 4) return undefined;
  const [owner, id, url, expires] = parts;
  const expires_at = Number(expires);
  if (!USER_ID.test(owner) || !isVideoId(id) || !isMxc(url) || !/^\d{1,16}$/.test(expires)) return undefined;
  return expires_at <= now ? 'expired' : { owner, id, url, expires_at };
}

/**
 * The key play tokens are signed with: `path`, made on first start (32 random bytes, mode 0600)
 * and kept, so addresses handed out survive a restart.
 */
export async function loadWatchKey(path: string): Promise<Buffer> {
  try {
    const key = await readFile(path);
    if (key.length < 32) throw new Error(`${path} holds fewer than 32 bytes; delete it to make a new key`);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  try {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(key);
    await file.close();
    return key;
  } catch (err) {
    // Two starting at once: the other one's key stands.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readFile(path);
    throw err;
  }
}

// --- Views -------------------------------------------------------------------------------------

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * View counts for this server's own videos, in memory and in `/data/watch-views.json`
 * (`{ views: { "<owner>|<id>": n } }`), written at most every `debounceMs` (atomically, as
 * StreamStore does). A viewer counts once per video per UTC day. Who has been counted today is
 * kept in memory only, as salted hashes, so a restart can count someone twice that day.
 */
export class ViewCounter {
  private counts = new Map<string, number>();
  private seen = new Set<string>();
  private seenDay = '';
  private readonly salt = randomBytes(16);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly debounceMs = 30_000,
    /** Past this many viewers in a day, new ones aren't counted (rather than memory growing without end). */
    private readonly maxSeen = 500_000
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const views = isRecord(raw) && isRecord(raw.views) ? raw.views : {};
      for (const [key, n] of Object.entries(views)) if (parseViewKey(key) && whole(n, 0)) this.counts.set(key, n);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Watch views not read from ${this.file}`, err);
    }
  }

  views(owner: string, id: string): number {
    return this.counts.get(viewKey(owner, id)) ?? 0;
  }

  /** Counts `viewer` (a Matrix ID, or `ip:<address>`) watching, unless they already did today. The count after. */
  count(owner: string, id: string, viewer: string, now = Date.now()): number {
    const key = viewKey(owner, id);
    const day = utcDay(now);
    if (day !== this.seenDay) {
      this.seen.clear();
      this.seenDay = day;
    }
    const mark = createHash('sha256').update(this.salt).update(`${key}\n${viewer}`).digest('base64url').slice(0, 22);
    if (this.seen.has(mark) || this.seen.size >= this.maxSeen) return this.counts.get(key) ?? 0;
    this.seen.add(mark);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    this.schedule();
    return n;
  }

  /** Forgets the counts of deleted videos. */
  drop(owner: string, ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) changed = this.counts.delete(viewKey(owner, id)) || changed;
    if (changed) this.schedule();
  }

  /** Writes now whatever is waiting. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.save();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Writes queue behind each other, so the file is always one whole state. */
  private save(): Promise<void> {
    const text = JSON.stringify({ views: Object.fromEntries(this.counts) });
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, this.file);
      } catch (err) {
        console.error(`Watch views not written to ${this.file}`, err);
      }
    });
    return this.writing;
  }
}
