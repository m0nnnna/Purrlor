import { EventType, type MatrixClient } from 'matrix-js-sdk';
import { isDemoMode } from '../demo/demoMode';
import { serverOfUserId } from './homeServer';
import { getOpenIdTokenCached } from './openIdToken';
import { formatBytes, getUploadLimit } from './postMedia';
import { ensureProfileRoom } from './profileFeed';
import { streamBaseFor } from './liveStream';
import { readMxc } from './profilePage';

/**
 * **WATCH** (docs/watch.md): videos people upload to their profiles, and the token server's
 * catalogue of them. A video is a file in Matrix media plus an `xyz.nekous.video` state event in
 * its owner's profile room (state key = the video's id). The rules for reading, the catalogue and
 * the signed play addresses are the token server's; this is how the app writes the event, talks to
 * that API and prepares an upload.
 */

export const VIDEO_EVENT_TYPE = 'xyz.nekous.video';
/** The two kinds of file that play as uploaded: nothing is transcoded. */
export const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];
/** For the file picker's `accept` attribute. */
export const VIDEO_ACCEPT = [...VIDEO_TYPES, '.mp4', '.m4v', '.webm'].join(',');

export const VIDEO_LIMITS = {
  title: 100,
  description: 5000,
  /** The widest a thumbnail may be, px. */
  thumbnailWidth: 1280,
  /** A video's thumbnail is grabbed this far in. */
  thumbnailAt: 0.1,
  /** Playlists on a page's videos block, and videos in each. */
  playlists: 20,
  playlistVideos: 200,
} as const;

export type VideoVisibility = 'public' | 'private';

/** A video as the catalogue and the public video route give it (camel-cased from `CatalogueVideo`). */
export type WatchVideo = {
  owner: string;
  id: string;
  roomId: string;
  title: string;
  description: string;
  /** Seconds. */
  duration: number;
  w: number;
  h: number;
  mimetype: VideoType;
  size: number;
  /** An mxc:// address (read through the app's media), or, from the public route, a public media path. */
  thumbnail: string;
  visibility: VideoVisibility;
  uploadedAt: number;
  /** What comments hang off, and what an edit carries. */
  anchor: string;
  /** Missing when the owner's server couldn't say. */
  views?: number;
  /** The owner's server name. */
  server: string;
};

export type LiveEntry = { owner: string; streamId: string; title: string; startedAt: number; server: string };
export type StoryEntry = { owner: string; roomId: string; latestTs: number; count: number };

export type Catalogue = { videos: WatchVideo[]; next?: string; live: LiveEntry[]; stories: StoryEntry[] };

/** Why the token server said no, by its `code` (docs/watch.md, "API"). */
export class WatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{16}$/;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

/** A new video id: 16 characters from `[A-Za-z0-9_-]`. */
export function newVideoId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined);

/** One of the two allowed types, lower-cased and without parameters, or undefined. */
export function readVideoType(value: unknown): VideoType | undefined {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const type = value.split(';')[0].trim().toLowerCase();
  return (VIDEO_TYPES as readonly string[]).includes(type) ? (type as VideoType) : undefined;
}

/** What a picked file is, as one of the allowed types: its declared type, or its extension when the browser says nothing. */
export function videoTypeOf(file: { type: string; name: string }): VideoType | undefined {
  const declared = readVideoType(file.type);
  if (declared) return declared;
  if (file.type !== '' && !file.type.toLowerCase().startsWith('video/')) return undefined;
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
  return extension === 'webm' ? 'video/webm' : undefined;
}

/** What a video's event holds besides its id and anchor. */
export type VideoFields = {
  url: string;
  mimetype: VideoType;
  size: number;
  duration: number;
  w: number;
  h: number;
  title: string;
  description: string;
  thumbnail: string;
  visibility: VideoVisibility;
  uploadedAt: number;
  anchor?: string;
};

/**
 * A video's fields out of its event content (the token server reads them the same way), or
 * undefined when a required field is missing or wrong: `{}` is a deleted video, and an event like
 * that is ignored everywhere.
 */
export function readVideoContent(raw: unknown, stateKey: string): VideoFields | undefined {
  if (!isRecord(raw) || !isVideoId(stateKey)) return undefined;
  const url = readMxc(raw.url);
  const thumbnail = readMxc(raw.thumbnail);
  const mimetype = raw.mimetype === 'video/mp4' || raw.mimetype === 'video/webm' ? raw.mimetype : undefined;
  const size = whole(raw.size);
  const duration = whole(raw.duration);
  const w = whole(raw.w);
  const h = whole(raw.h);
  const uploadedAt = whole(raw.uploaded_at);
  const visibility = raw.visibility === 'public' || raw.visibility === 'private' ? raw.visibility : undefined;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description : '';
  if (!url || !thumbnail || !mimetype || !size || size < 1 || !duration || duration < 1 || !w || w < 1 || !h || h < 1) return undefined;
  if (!visibility || uploadedAt === undefined || title.length < 1 || [...title].length > VIDEO_LIMITS.title) return undefined;
  if ([...description].length > VIDEO_LIMITS.description) return undefined;
  const anchor = typeof raw.anchor === 'string' && raw.anchor.startsWith('$') ? raw.anchor : undefined;
  return { url, mimetype, size, duration, w, h, title, description, thumbnail, visibility, uploadedAt, ...(anchor && { anchor }) };
}

/** The event content for a write. Every number is whole (events can't hold fractions). */
export function buildVideoContent(fields: VideoFields): Record<string, unknown> {
  return {
    url: fields.url,
    mimetype: fields.mimetype,
    size: Math.round(fields.size),
    duration: Math.max(1, Math.round(fields.duration)),
    w: Math.max(1, Math.round(fields.w)),
    h: Math.max(1, Math.round(fields.h)),
    title: fields.title,
    description: fields.description,
    thumbnail: fields.thumbnail,
    visibility: fields.visibility,
    uploaded_at: Math.round(fields.uploadedAt),
    ...(fields.anchor && { anchor: fields.anchor }),
  };
}

/** A title as the event takes it: one line, trimmed, at most 100 characters; undefined when empty. */
export function cleanTitle(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? [...line].slice(0, VIDEO_LIMITS.title).join('') : undefined;
}

// --- Writing ------------------------------------------------------------------------------------

/** Only the owner may send the type: a profile room made before WATCH gates just posts, so the first video raises it to 100 (as for stories). */
async function gateVideoEvents(mx: MatrixClient, roomId: string): Promise<void> {
  const current = mx.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<Record<string, any>>();
  if (!current) return;
  const events = (current.events ?? {}) as Record<string, number>;
  if (events[VIDEO_EVENT_TYPE] === 100) return;
  await mx.sendStateEvent(roomId, EventType.RoomPowerLevels, { ...current, events: { ...events, [VIDEO_EVENT_TYPE]: 100 } } as any, '');
}

const sendVideoEvent = (mx: MatrixClient, roomId: string, id: string, content: Record<string, unknown>) =>
  // A custom state type; matrix-js-sdk's typing only knows the spec's.
  mx.sendStateEvent(roomId, VIDEO_EVENT_TYPE as never, content as never, id);

/** The video as the owner's own write gives it, before the catalogue (rebuilt every minute) has it. */
function videoFrom(owner: string, roomId: string, id: string, fields: VideoFields, anchor: string, views?: number): WatchVideo {
  return {
    owner,
    id,
    roomId,
    title: fields.title,
    description: fields.description,
    duration: fields.duration,
    w: fields.w,
    h: fields.h,
    mimetype: fields.mimetype,
    size: fields.size,
    thumbnail: fields.thumbnail,
    visibility: fields.visibility,
    uploadedAt: fields.uploadedAt,
    anchor,
    ...(views !== undefined && { views }),
    server: serverOfUserId(owner) ?? '',
  };
}

export type VideoDetails = { title: string; description: string; visibility: VideoVisibility };

/** A picked file, checked and measured, with the picture that will stand for it. */
export type PreparedVideo = {
  file: File;
  mimetype: VideoType;
  duration: number;
  w: number;
  h: number;
  /** A frame about 10% in, or undefined if the browser couldn't draw one (then the person picks a picture). */
  thumbnail?: Blob;
};

/** The most a video may weigh: the smaller of the token server's cap and the homeserver's upload limit. */
export async function videoSizeLimit(mx: MatrixClient): Promise<number | undefined> {
  const [limits, homeserver] = await Promise.all([fetchWatchLimits().catch(() => undefined), getUploadLimit(mx)]);
  const caps = [limits?.maxBytes, homeserver].filter((cap): cap is number => typeof cap === 'number' && cap > 0);
  return caps.length > 0 ? Math.min(...caps) : undefined;
}

/**
 * Checks a picked file (an allowed type, under the size cap) and reads its length, picture size and
 * a thumbnail from a `<video>` element. Throws a sentence for the dialog to show.
 */
export async function prepareVideo(mx: MatrixClient, file: File): Promise<PreparedVideo> {
  const mimetype = videoTypeOf(file);
  if (!mimetype) throw new Error(`${file.name} isn’t a video Purrlor can play. Use an MP4 or a WebM.`);
  const limit = await videoSizeLimit(mx);
  if (limit !== undefined && file.size > limit) throw new Error(`${file.name} is ${formatBytes(file.size)}; a video can be up to ${formatBytes(limit)}.`);
  const probe = await probeVideo(file);
  if (!probe) throw new Error(`${file.name} can’t be played in this browser, so it wouldn’t play for others either.`);
  return { file, mimetype, ...probe };
}

type Probe = { duration: number; w: number; h: number; thumbnail?: Blob };

/** Length, picture size and a frame at ~10% from a `<video>` element; undefined if the browser can't read the file in a few seconds. */
export function probeVideo(file: File): Promise<Probe | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = (value: Probe | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 15_000);
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.onerror = () => finish(undefined);
    video.onloadedmetadata = () => {
      const { duration, videoWidth: w, videoHeight: h } = video;
      if (!Number.isFinite(duration) || duration <= 0 || !w || !h) {
        finish(undefined);
        return;
      }
      const measured = { duration: Math.max(1, Math.round(duration)), w, h };
      const grab = () => {
        void frameToJpeg(video, w, h).then((thumbnail) => finish({ ...measured, ...(thumbnail && { thumbnail }) }));
      };
      video.onseeked = grab;
      video.currentTime = duration * VIDEO_LIMITS.thumbnailAt;
    };
    video.src = url;
  });
}

/** A picture scaled to at most 1280 wide, as a JPEG; undefined if the canvas can't. */
export function frameToJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob | undefined> {
  const scale = Math.min(1, VIDEO_LIMITS.thumbnailWidth / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(undefined);
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.85));
}

/** A picture the person picked, scaled down to a thumbnail (JPEG, 1280 wide at most). */
export async function thumbnailFromPicture(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} isn’t a picture.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} can’t be read as a picture.`);
  }
  const blob = await frameToJpeg(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  if (!blob) throw new Error(`${file.name} can’t be used as a thumbnail.`);
  return blob;
}

/** A video's starting title from its file name: no extension, underscores as spaces, one line. */
export function titleFromFileName(name: string): string {
  return cleanTitle(name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/_+/g, ' ')) ?? 'Untitled video';
}

/**
 * Uploads the file and its thumbnail to Matrix media (plain: the token server serves the file, and
 * a private video's file only reaches someone through a play address), then sends the event. The
 * first write has no `anchor`; the event's own id is the anchor from then on.
 */
export async function publishVideo(
  mx: MatrixClient,
  prepared: PreparedVideo,
  thumbnail: Blob,
  details: VideoDetails,
  displayName: string,
  onProgress?: (fraction: number) => void
): Promise<WatchVideo> {
  const owner = mx.getUserId();
  const title = cleanTitle(details.title);
  if (!owner) throw new Error('You’re not signed in.');
  if (!title) throw new Error('Give the video a title.');
  const [uploadedFile, uploadedThumb] = await Promise.all([
    mx.uploadContent(prepared.file, {
      type: prepared.mimetype,
      name: prepared.file.name,
      progressHandler: ({ loaded, total }) => onProgress?.(total > 0 ? Math.min(1, loaded / total) : 0),
    }),
    mx.uploadContent(thumbnail, { type: 'image/jpeg', name: 'thumbnail.jpg' }),
  ]);
  const roomId = await ensureProfileRoom(mx, displayName);
  await gateVideoEvents(mx, roomId).catch(() => undefined);
  const id = newVideoId();
  const fields: VideoFields = {
    url: uploadedFile.content_uri,
    mimetype: prepared.mimetype,
    size: prepared.file.size,
    duration: prepared.duration,
    w: prepared.w,
    h: prepared.h,
    title,
    description: details.description.slice(0, VIDEO_LIMITS.description),
    thumbnail: uploadedThumb.content_uri,
    visibility: details.visibility,
    uploadedAt: Date.now(),
  };
  const { event_id: eventId } = await sendVideoEvent(mx, roomId, id, buildVideoContent(fields));
  onProgress?.(1);
  return videoFrom(owner, roomId, id, fields, eventId);
}

/** Changes a video's title, description, visibility or thumbnail: the whole event again, with `anchor` set and `uploaded_at` kept. */
export async function editVideo(
  mx: MatrixClient,
  video: WatchVideo,
  changes: VideoDetails & { thumbnail?: Blob }
): Promise<WatchVideo> {
  const title = cleanTitle(changes.title);
  if (!title) throw new Error('Give the video a title.');
  const thumbnail = changes.thumbnail ? (await mx.uploadContent(changes.thumbnail, { type: 'image/jpeg', name: 'thumbnail.jpg' })).content_uri : video.thumbnail;
  const fields: VideoFields = {
    url: await ownFileUrl(mx, video),
    mimetype: video.mimetype,
    size: video.size,
    duration: video.duration,
    w: video.w,
    h: video.h,
    title,
    description: changes.description.slice(0, VIDEO_LIMITS.description),
    thumbnail,
    visibility: changes.visibility,
    uploadedAt: video.uploadedAt,
    anchor: video.anchor,
  };
  await sendVideoEvent(mx, video.roomId, video.id, buildVideoContent(fields));
  return { ...video, title, description: fields.description, thumbnail, visibility: fields.visibility };
}

/** The file's mxc address, read from the current event: the catalogue doesn't carry it. */
async function ownFileUrl(mx: MatrixClient, video: WatchVideo): Promise<string> {
  const current = await mx.getStateEvent(video.roomId, VIDEO_EVENT_TYPE, video.id);
  const url = readMxc((current as Record<string, unknown>)?.url);
  if (!url) throw new Error('Couldn’t read this video’s file. Try again.');
  return url;
}

/** Deletes a video: the event again with `{}`. The file stays on the media server until an admin purges it. */
export async function deleteVideo(mx: MatrixClient, video: Pick<WatchVideo, 'roomId' | 'id'>): Promise<void> {
  await sendVideoEvent(mx, video.roomId, video.id, {});
}

// --- The token server's API ---------------------------------------------------------------------

async function call<T>(url: string, init: RequestInit, read: (body: unknown) => T): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const b = isRecord(body) ? body : {};
    throw new WatchError(response.status, typeof b.code === 'string' ? b.code : 'unavailable', typeof b.error === 'string' ? b.error : `HTTP ${response.status}`);
  }
  return read(body);
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const MEDIA_PATH = /^\/api\/public\/media\/[A-Za-z0-9.\-:[\]]{1,255}\/[A-Za-z0-9_-]{1,255}$/;

/** One video from the catalogue or the public route, checked: undefined if it isn't one. */
export function parseWatchVideo(raw: unknown): WatchVideo | undefined {
  if (!isRecord(raw) || typeof raw.owner !== 'string' || !isVideoId(raw.id) || typeof raw.room_id !== 'string' || !raw.room_id.startsWith('!')) return undefined;
  const mimetype = readVideoType(raw.mimetype);
  const thumbnail = readMxc(raw.thumbnail) ?? (typeof raw.thumbnail === 'string' && MEDIA_PATH.test(raw.thumbnail) ? raw.thumbnail : undefined);
  const visibility = raw.visibility === 'public' || raw.visibility === 'private' ? raw.visibility : undefined;
  const duration = whole(raw.duration);
  const uploadedAt = whole(raw.uploaded_at);
  if (!mimetype || !thumbnail || !visibility || typeof raw.title !== 'string' || !duration || uploadedAt === undefined || typeof raw.anchor !== 'string') return undefined;
  const views = whole(raw.views);
  return {
    owner: raw.owner,
    id: raw.id,
    roomId: raw.room_id,
    title: raw.title.slice(0, VIDEO_LIMITS.title),
    description: typeof raw.description === 'string' ? raw.description.slice(0, VIDEO_LIMITS.description) : '',
    duration,
    w: whole(raw.w) ?? 16,
    h: whole(raw.h) ?? 9,
    mimetype,
    size: whole(raw.size) ?? 0,
    thumbnail,
    visibility,
    uploadedAt,
    anchor: raw.anchor,
    ...(views !== undefined && views >= 0 && { views }),
    server: typeof raw.server === 'string' ? raw.server : (serverOfUserId(raw.owner) ?? ''),
  };
}

function parseLive(raw: unknown): LiveEntry | undefined {
  if (!isRecord(raw) || typeof raw.owner !== 'string' || typeof raw.stream_id !== 'string' || typeof raw.title !== 'string') return undefined;
  return { owner: raw.owner, streamId: raw.stream_id, title: raw.title.slice(0, 120), startedAt: whole(raw.started_at) ?? 0, server: typeof raw.server === 'string' ? raw.server : '' };
}

function parseStoryEntry(raw: unknown): StoryEntry | undefined {
  if (!isRecord(raw) || typeof raw.owner !== 'string' || typeof raw.room_id !== 'string') return undefined;
  return { owner: raw.owner, roomId: raw.room_id, latestTs: whole(raw.latest_ts) ?? 0, count: Math.max(1, whole(raw.count) ?? 1) };
}

function parseCatalogue(body: unknown): Catalogue {
  const b = isRecord(body) ? body : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return {
    videos: list(b.videos).flatMap((v) => parseWatchVideo(v) ?? []),
    ...(typeof b.next === 'string' && b.next && { next: b.next }),
    live: list(b.live).flatMap((v) => parseLive(v) ?? []),
    stories: list(b.stories).flatMap((v) => parseStoryEntry(v) ?? []),
  };
}

export type CatalogueQuery = { q?: string; owners?: string[]; cursor?: string; limit?: number };

/** One page of the catalogue, from this server (it answers for its peers' people too). `live` and `stories` come with the first page only. */
export async function fetchCatalogue(mx: MatrixClient, query: CatalogueQuery = {}): Promise<Catalogue> {
  if (isDemoMode()) return { videos: [], live: [], stories: [] };
  const { q, owners, cursor, limit } = query;
  const body = { openid_token: await getOpenIdTokenCached(mx), ...(q?.trim() && { q: q.trim() }), ...(owners && { owners }), ...(cursor && { cursor }), ...(limit && { limit }) };
  return call('/api/public/watch/catalogue', post(body), parseCatalogue);
}

/** The whole of a channel, read page by page from the catalogue (at most `pages` of them), newest first. */
export async function fetchChannelVideos(mx: MatrixClient, owner: string, pages = 9): Promise<WatchVideo[]> {
  const videos: WatchVideo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const answer = await fetchCatalogue(mx, { owners: [owner], limit: 60, ...(cursor && { cursor }) });
    videos.push(...answer.videos);
    cursor = answer.next;
    if (!cursor) break;
  }
  return videos;
}

export type PlayAnswer = { url: string; expiresAt: number; views: number };

/**
 * Asks the **owner's** server to play a video: it counts the view and gives back an address its
 * token server serves the file from, with range requests so the player can seek. `base` is that
 * server (streamBaseFor); the returned `url` is absolute, and is what the player's `src` must be:
 * never the mxc, which the homeserver would serve without ranges.
 */
export async function playVideo(base: string, mx: MatrixClient | undefined, owner: string, videoId: string): Promise<PlayAnswer> {
  const body = { ...(mx && { openid_token: await getOpenIdTokenCached(mx) }), owner, video_id: videoId };
  return call(`${base}/api/public/watch/play`, post(body), (answer) => {
    const b = isRecord(answer) ? answer : {};
    if (typeof b.url !== 'string' || !b.url.startsWith('/api/public/watch/file/')) throw new WatchError(502, 'bad_answer', 'The server’s answer didn’t make sense');
    return { url: `${base}${b.url}`, expiresAt: whole(b.expires_at) ?? 0, views: Math.max(0, whole(b.views) ?? 0) };
  });
}

/** Where to play `owner`'s videos from: their own server (`''` is this one), or undefined if it isn't one this app knows. */
export const playBaseFor = streamBaseFor;

/** View counts of up to 100 of one server's own videos, by `<owner>|<id>`; empty when it doesn't answer. */
export async function fetchViews(base: string, ids: string[]): Promise<Record<string, number>> {
  if (isDemoMode() || ids.length === 0) return {};
  try {
    return await call(`${base}/api/public/watch/views?ids=${encodeURIComponent(ids.slice(0, 100).join(','))}`, {}, (body) => {
      const views = isRecord(body) && isRecord(body.views) ? body.views : {};
      return Object.fromEntries(Object.entries(views).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
    });
  } catch {
    return {};
  }
}

/** The token server's caps (and what it accepts), or undefined if it doesn't answer. */
export async function fetchWatchLimits(): Promise<{ maxBytes: number; maxVideos: number } | undefined> {
  if (isDemoMode()) return undefined;
  return call('/api/public/watch/limits', {}, (body) => {
    const b = isRecord(body) ? body : {};
    const maxBytes = whole(b.max_bytes);
    const maxVideos = whole(b.max_videos);
    return maxBytes && maxVideos ? { maxBytes, maxVideos } : undefined;
  });
}

/** A public video for the public web's page, or undefined (404: gone, private, or its owner's public web is off). */
export async function fetchPublicVideo(user: string, id: string): Promise<WatchVideo | undefined> {
  if (isDemoMode() || !isVideoId(id)) return undefined;
  try {
    return await call(`/api/public/watch/${encodeURIComponent(user.replace(/^@/, ''))}/${id}`, {}, (body) => parseWatchVideo(body));
  } catch (err) {
    if (err instanceof WatchError && err.status === 404) return undefined;
    throw err;
  }
}

/** What the player says when a play is refused. */
export function playRefusalText(err: unknown): string {
  if (!(err instanceof WatchError)) return 'Couldn’t reach the video. Check your connection and try again.';
  switch (err.code) {
    case 'not_found':
      return 'This video isn’t available any more.';
    case 'hidden':
      return 'This video isn’t available.';
    case 'rate_limited':
      return 'Too many tries. Wait a moment and press play again.';
    default:
      return err.message || 'The video couldn’t start.';
  }
}

// --- Showing ------------------------------------------------------------------------------------

/** `/@name/video/<id>`: a video's page. */
export function videoPath(publicPath: string, id: string): string {
  return `${publicPath}/video/${id}`;
}

/** "1.2K views", "1 view", or nothing when the count isn't known. */
export function formatViews(views: number | undefined): string {
  if (views === undefined) return '';
  if (views === 1) return '1 view';
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (views >= 1000) return `${(views / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${views} views`;
}

/** Newest first, as the catalogue sorts them. */
export function byNewest(a: Pick<WatchVideo, 'uploadedAt' | 'id'>, b: Pick<WatchVideo, 'uploadedAt' | 'id'>): number {
  return b.uploadedAt - a.uploadedAt || (a.id < b.id ? -1 : 1);
}

/** A length on a card or a seek bar: 4:07, or 1:02:03 for an hour or more. */
export function formatLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
