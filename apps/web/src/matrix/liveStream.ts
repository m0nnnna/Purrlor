import type { MatrixClient, Room } from 'matrix-js-sdk';
import { isDemoMode } from '../demo/demoMode';
import { serverOfUserId } from './homeServer';
import { getOpenIdTokenCached } from './openIdToken';
import { fetchPeers, peerOf } from './peers';

/**
 * Live streams (docs/streaming.md): the token server's API, the pointer in a profile room that
 * says its owner is live, and which server a stream is on. The rules are the token server's; this
 * is how the app talks to it.
 */

/** In the owner's profile room while they're live; `{}` after. A hint, always checked with their server. */
export const LIVE_STREAM_EVENT = 'xyz.nekous.live_stream';
/** In a stream's chat room, set by the token server's bot. */
export const STREAM_CHAT_EVENT = 'xyz.nekous.stream_chat';

export type LivePointer = { streamId: string; title: string; startedAt: number };

export type StreamState = 'starting' | 'live' | 'ended';

export type PublicStream = {
  id: string;
  owner: string;
  title: string;
  state: StreamState;
  liveAt: number | null;
  endedAt: number | null;
  viewers?: number;
  chatRoom: string | null;
  /** Relative to the stream's server (`/api/public/streams/…`). */
  thumbnail: string | null;
  replay: { durationMs: number; url: string } | null;
  /** Ended, and the replay's file is still being written. Missing from older servers. */
  saving?: boolean;
  expiresAt: number | null;
};

export type ChatMessage = { id: string; ts: number; sender: string; body: string };

/** Why the token server said no, by its `code` (docs/streaming.md, "API"). */
export class StreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const STREAM_ID = /^[A-Za-z0-9_-]{16}$/;

export function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID.test(value);
}

/** The pointer out of its state content, or undefined when it's empty or isn't one. */
export function readLivePointer(content: Record<string, unknown> | undefined): LivePointer | undefined {
  if (!content || !isStreamId(content.stream_id)) return undefined;
  const title = typeof content.title === 'string' ? content.title.slice(0, 120) : '';
  const startedAt = typeof content.started_at === 'number' && Number.isFinite(content.started_at) ? content.started_at : 0;
  return { streamId: content.stream_id, title, startedAt };
}

export function livePointerOf(room: Room | null | undefined): LivePointer | undefined {
  return readLivePointer(room?.currentState.getStateEvents(LIVE_STREAM_EVENT, '')?.getContent());
}

/** Says (or, with undefined, stops saying) in your own profile room that you're live. */
export async function writeLivePointer(mx: MatrixClient, profileRoomId: string, pointer: LivePointer | undefined): Promise<void> {
  const content = pointer ? { stream_id: pointer.streamId, title: pointer.title, started_at: pointer.startedAt } : {};
  // A custom state type; matrix-js-sdk's typing only knows the spec's.
  await mx.sendStateEvent(profileRoomId, LIVE_STREAM_EVENT as never, content as never, '');
}

/** A stream's chat room: the app keeps it out of the room list (backgroundRooms.ts). */
export function isStreamChatRoom(room: Room): boolean {
  return !!room.currentState.getStateEvents(STREAM_CHAT_EVENT, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One stream from the API, checked: a stream from another server is read like anything else from outside. */
export function parseStream(raw: unknown): PublicStream | undefined {
  if (!isRecord(raw) || !isStreamId(raw.id) || typeof raw.owner !== 'string' || typeof raw.title !== 'string') return undefined;
  if (raw.state !== 'starting' && raw.state !== 'live' && raw.state !== 'ended') return undefined;
  const replay =
    isRecord(raw.replay) && typeof raw.replay.durationMs === 'number' && typeof raw.replay.url === 'string' && raw.replay.url.startsWith('/api/public/streams/')
      ? { durationMs: raw.replay.durationMs, url: raw.replay.url }
      : null;
  const thumbnail = typeof raw.thumbnail === 'string' && raw.thumbnail.startsWith('/api/public/streams/') ? raw.thumbnail : null;
  return {
    id: raw.id,
    owner: raw.owner,
    title: raw.title.slice(0, 120),
    state: raw.state,
    liveAt: num(raw.liveAt),
    endedAt: num(raw.endedAt),
    ...(typeof raw.viewers === 'number' && { viewers: Math.max(0, Math.floor(raw.viewers)) }),
    chatRoom: typeof raw.chatRoom === 'string' && raw.chatRoom.startsWith('!') ? raw.chatRoom : null,
    thumbnail,
    replay,
    ...(raw.saving === true && { saving: true }),
    expiresAt: num(raw.expiresAt),
  };
}

export function parseChat(raw: unknown): { messages: ChatMessage[]; avatars: Record<string, string> } {
  const list = isRecord(raw) && Array.isArray(raw.messages) ? raw.messages : [];
  const messages = list.flatMap((m): ChatMessage[] =>
    isRecord(m) && typeof m.id === 'string' && typeof m.sender === 'string' && typeof m.body === 'string' && typeof m.ts === 'number'
      ? [{ id: m.id, ts: m.ts, sender: m.sender, body: m.body.slice(0, 2000) }]
      : []
  );
  const avatars: Record<string, string> = {};
  if (isRecord(raw) && isRecord(raw.authors)) {
    for (const [userId, author] of Object.entries(raw.authors)) {
      if (isRecord(author) && typeof author.avatarUrl === 'string' && author.avatarUrl.startsWith('mxc://')) avatars[userId] = author.avatarUrl;
    }
  }
  return { messages, avatars };
}

/**
 * Where a person's streams are: their own server's app. This server's people: here (`''`, the
 * same origin). An approved peer's: its address. Anyone else: nowhere this app shows streams from.
 */
export async function streamBaseFor(userId: string, ownServer: string | undefined): Promise<string | undefined> {
  const server = serverOfUserId(userId);
  if (!server) return undefined;
  if (!ownServer || server === ownServer) return '';
  const peer = peerOf(server, await fetchPeers());
  return peer ? peer.url.replace(/\/+$/, '') : undefined;
}

async function call<T>(url: string, init: RequestInit, read: (body: unknown) => T): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const b = isRecord(body) ? body : {};
    throw new StreamError(response.status, typeof b.code === 'string' ? b.code : 'unavailable', typeof b.error === 'string' ? b.error : `HTTP ${response.status}`);
  }
  return read(body);
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function readStreamAnswer(body: unknown): PublicStream {
  const stream = parseStream(isRecord(body) ? body.stream : undefined);
  if (!stream) throw new StreamError(502, 'bad_answer', 'The server’s answer didn’t make sense');
  return stream;
}

// --- The streamer's side (always this server) ---------------------------------------------------

export async function startStream(mx: MatrixClient, title: string): Promise<{ stream: PublicStream; token: string; url: string }> {
  return call('/api/public/streams', post({ openid_token: await getOpenIdTokenCached(mx), title }), (body) => {
    const b = isRecord(body) ? body : {};
    if (typeof b.token !== 'string' || typeof b.url !== 'string') throw new StreamError(502, 'bad_answer', 'The server’s answer didn’t make sense');
    return { stream: readStreamAnswer(body), token: b.token, url: b.url };
  });
}

export async function markStreamLive(mx: MatrixClient, id: string): Promise<PublicStream> {
  return call(`/api/public/streams/${id}/live`, post({ openid_token: await getOpenIdTokenCached(mx) }), readStreamAnswer);
}

export async function stopStream(mx: MatrixClient, id: string): Promise<PublicStream> {
  return call(`/api/public/streams/${id}/stop`, post({ openid_token: await getOpenIdTokenCached(mx) }), readStreamAnswer);
}

export async function sendThumbnail(mx: MatrixClient, id: string, picture: Blob): Promise<void> {
  const token = await getOpenIdTokenCached(mx);
  const response = await fetch(`/api/public/streams/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': picture.type, Authorization: `OpenID ${token.access_token} ${token.matrix_server_name}` },
    body: picture,
  });
  if (!response.ok) throw new StreamError(response.status, 'thumbnail', `HTTP ${response.status}`);
}

export async function downloadLinks(mx: MatrixClient, id: string): Promise<{ replay?: string; chat?: string }> {
  return call(`/api/public/streams/${id}/download`, post({ openid_token: await getOpenIdTokenCached(mx) }), (body) => {
    const b = isRecord(body) ? body : {};
    const link = (value: unknown) => (typeof value === 'string' && value.startsWith(`/api/public/streams/${id}/files/`) ? value : undefined);
    return { replay: link(b.replay), chat: link(b.chat) };
  });
}

// --- Anyone's side (the stream's server) --------------------------------------------------------

export async function fetchStream(base: string, id: string): Promise<PublicStream | undefined> {
  if (isDemoMode() || !isStreamId(id)) return undefined;
  try {
    return await call(`${base}/api/public/streams/${id}`, {}, readStreamAnswer);
  } catch (err) {
    if (err instanceof StreamError && err.status === 404) return undefined;
    throw err;
  }
}

/** A person's live stream or unexpired replays, newest first. */
export async function fetchStreamsOf(base: string, owner: string): Promise<PublicStream[]> {
  if (isDemoMode()) return [];
  return call(`${base}/api/public/streams?owner=${encodeURIComponent(owner)}`, {}, (body) =>
    (isRecord(body) && Array.isArray(body.streams) ? body.streams : []).flatMap((s) => parseStream(s) ?? [])
  );
}

/** A viewer token. Signed out, `mx` is undefined. `resume` is the identity had before a drop. */
export async function viewerToken(
  base: string,
  id: string,
  mx: MatrixClient | undefined,
  resume?: string
): Promise<{ token: string; url: string; identity: string }> {
  const body = { ...(mx && { openid_token: await getOpenIdTokenCached(mx) }), ...(resume && { resume }) };
  return call(`${base}/api/public/streams/${id}/token`, post(body), (answer) => {
    const b = isRecord(answer) ? answer : {};
    if (typeof b.token !== 'string' || typeof b.url !== 'string' || typeof b.identity !== 'string') {
      throw new StreamError(502, 'bad_answer', 'The server’s answer didn’t make sense');
    }
    return { token: b.token, url: b.url, identity: b.identity };
  });
}

export async function fetchChat(base: string, id: string, after?: number): Promise<{ messages: ChatMessage[]; avatars: Record<string, string> }> {
  return call(`${base}/api/public/streams/${id}/chat${after ? `?after=${after}` : ''}`, {}, parseChat);
}

/** What the player says when a token is refused. */
export function refusalText(err: unknown): string {
  if (!(err instanceof StreamError)) return 'Couldn’t reach the stream. Check your connection and try again.';
  switch (err.code) {
    case 'stream_full':
      return 'This server’s streams are full right now. Try again in a little while.';
    case 'guest_full':
      return 'This stream is full for people who aren’t signed in. Sign in to watch.';
    case 'not_found':
      return 'This stream isn’t live any more.';
    case 'rate_limited':
      return 'Too many tries. Wait a moment and press play again.';
    default:
      return err.message || 'The stream couldn’t start.';
  }
}

/** What going live says when refused. */
export function goLiveRefusalText(err: unknown): string {
  if (!(err instanceof StreamError)) return 'Couldn’t reach the server. Check your connection and try again.';
  switch (err.code) {
    case 'already_live':
      return 'You’re already live.';
    case 'server_busy':
      return 'This server has as many streams live as it can carry. Try again later.';
    case 'streaming_off':
      return 'Streaming is switched off on this server.';
    case 'not_local':
      return 'You can only go live on your own server.';
    case 'bad_title':
      return 'Give your stream a title (up to 120 characters).';
    default:
      return err.message || 'Couldn’t go live.';
  }
}

/** `/@name/live/<id>`: the watch page. */
export function watchPath(publicPath: string, id: string): string {
  return `${publicPath}/live/${id}`;
}

/** "1:02:03" or "4:05". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
