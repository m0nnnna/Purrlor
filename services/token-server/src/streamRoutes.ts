import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { Router, type Request, type Response } from 'express';
import { AccessToken, type RoomServiceClient } from 'livekit-server-sdk';
import { Direction, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { clientIp } from './clientIp.js';
import { profilePath } from './peers.js';
import { isMxc, linkCardHtml, localUserId, parseRange, serverNameOf, type RawEvent } from './publicWeb.js';
import type { Recorder } from './recordings.js';
import {
  admitViewer,
  chatLogText,
  chatMessages,
  chatPowerLevels,
  cleanTitle,
  countViewers,
  downloadAllowed,
  downloadSignature,
  dueAction,
  endedRecord,
  guestIdentity,
  isGuestIdentity,
  isPublic,
  isStreamId,
  newStreamId,
  openIdFromHeader,
  publicStream,
  STARTING_TIMEOUT_MS,
  STREAM_CHAT_EVENT,
  streamerGrant,
  streamListing,
  streamRoomName,
  VIEWER_TOKEN_TTL_S,
  viewerGrant,
  type ChatMessage,
  type DownloadKind,
  type StreamRecord,
  type StreamSettings,
  type StreamStore,
} from './streams.js';
import { RateLimiter } from './webhooks.js';

/**
 * Live streams over HTTP (docs/streaming.md, "API"): going live, watching, the chat room and the
 * replays. The rules are in streams.ts; this does LiveKit, Matrix and the files.
 */

export type StreamDeps = {
  settings: StreamSettings;
  store: StreamStore;
  rooms: RoomServiceClient;
  recorder: Recorder;
  apiKey: string;
  apiSecret: string;
  /** The `wss://` address viewers' browsers connect to (LIVEKIT_PUBLIC_URL). */
  livekitUrl: string;
  /** Who a Matrix OpenID token belongs to (throws if it doesn't check out). */
  caller(openIdToken: unknown): Promise<string>;
  serverName(): Promise<string>;
  /** People an admin hid (docs/public-web.md): they can't go live, and their streams aren't shown. */
  hidden(): Promise<Set<string>>;
  mx(): Promise<MatrixClient>;
  dataDir: string;
};

const SWEEP_MS = 15_000;
const CHAT_CACHE_MS = 2_000;
const THUMBNAIL_MAX_BYTES = 300 * 1024;
const DOWNLOAD_LINK_MS = 10 * 60_000;
/** Messages read back for the chat log: plenty for a 12-hour stream. */
const CHAT_LOG_MAX_EVENTS = 50_000;

const RATE_SCALE = Number(process.env.PUBLIC_WEB_RATE_SCALE) >= 1 ? Number(process.env.PUBLIC_WEB_RATE_SCALE) : 1;
const readLimiter = new RateLimiter(60 * RATE_SCALE, 120 * RATE_SCALE);
const tokenLimiter = new RateLimiter(10 * RATE_SCALE, 20 * RATE_SCALE);

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function baseUrl(req: Request): string {
  return (process.env.PUBLIC_WEB_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

export class Streams {
  /** When the sweep last saw each live stream's streamer in its room. */
  private streamerSeen = new Map<string, number>();
  /** Viewers per live stream, as of the last sweep (for answers; the cap counts afresh). */
  private viewers = new Map<string, number>();
  /** Viewer tokens just given, not yet seen in a room. */
  private pending: { identity: string; at: number }[] = [];
  private thumbnails = new Map<string, { type: string; data: Buffer }>();
  private chatCache = new Map<string, { at: number; messages: ChatMessage[] }>();
  private avatars = new Map<string, { at: number; avatarUrl?: string }>();
  /** Chats being closed for writing and logged, by stream. */
  private finishing = new Map<string, Promise<void>>();
  /** Signs download links; made each start, so a restart ends links already handed out. */
  private readonly secret = randomBytes(32);
  private sweeping = false;

  constructor(private readonly deps: StreamDeps) {}

  async start(): Promise<void> {
    await this.deps.store.load();
    setInterval(() => void this.sweep(), SWEEP_MS).unref();
  }

  // --- Reading ---------------------------------------------------------------------------------

  private async visible(id: string): Promise<StreamRecord | undefined> {
    const record = isStreamId(id) ? this.deps.store.get(id) : undefined;
    if (!record || !isPublic(record, Date.now())) return undefined;
    return (await this.deps.hidden()).has(record.owner) ? undefined : record;
  }

  private shape(record: StreamRecord) {
    return publicStream(record, { viewers: this.viewers.get(record.id), hasThumbnail: this.thumbnails.has(record.id) });
  }

  private async owned(id: string, openIdToken: unknown): Promise<StreamRecord> {
    const record = isStreamId(id) ? this.deps.store.get(id) : undefined;
    if (!record) throw new Refusal(404, 'not_found', 'No such stream');
    const userId = await this.who(openIdToken);
    if (userId !== record.owner) throw new Refusal(403, 'not_yours', 'Only the streamer can do that');
    return record;
  }

  private async who(openIdToken: unknown): Promise<string> {
    if (!openIdToken) throw new Refusal(401, 'auth_required', 'openid_token is required');
    try {
      return await this.deps.caller(openIdToken);
    } catch {
      throw new Refusal(401, 'auth_failed', 'Authentication failed');
    }
  }

  // --- Going live ------------------------------------------------------------------------------

  async goLive(openIdToken: unknown, rawTitle: unknown, base: string): Promise<{ record: StreamRecord; token: string }> {
    const { settings, store } = this.deps;
    const userId = await this.who(openIdToken);
    if (!settings.enabled) throw new Refusal(403, 'streaming_off', 'Streaming is switched off on this server');
    const server = await this.deps.serverName();
    if (serverNameOf(userId) !== server) throw new Refusal(403, 'not_local', 'Only people on this server can go live here');
    if ((await this.deps.hidden()).has(userId)) throw new Refusal(403, 'hidden', 'Streaming isn’t available for this account');
    const title = cleanTitle(rawTitle);
    if (!title) throw new Refusal(400, 'bad_title', 'A title is 1 to 120 characters');

    // A stream of theirs that never went live (a reload while connecting) gives way to the new one.
    for (const old of store.all()) if (old.owner === userId && old.state === 'starting') await this.drop(old);
    const active = store.all().filter((r) => r.state !== 'ended');
    if (active.some((r) => r.owner === userId)) throw new Refusal(409, 'already_live', 'You’re already live');
    if (active.length >= settings.maxLive) throw new Refusal(409, 'server_busy', 'This server has as many streams live as it can carry');

    const id = newStreamId();
    const roomName = streamRoomName(id);
    // Kept while empty as long as a stream may be starting: were LiveKit to drop it first, joining
    // would make it afresh with the defaults, and voice's limit of 50.
    await this.deps.rooms.createRoom({ name: roomName, maxParticipants: settings.viewerCap + 4, emptyTimeout: STARTING_TIMEOUT_MS / 1000, departureTimeout: 120 });
    const chatRoom = await this.makeChatRoom(id, userId, title, `${base}${profilePath(userId, server)}/live/${id}`).catch((err: unknown) => {
      console.error(`Stream ${id}: chat room not made`, err);
      return null;
    });
    const record: StreamRecord = {
      id,
      owner: userId,
      title,
      state: 'starting',
      createdAt: Date.now(),
      liveAt: null,
      endedAt: null,
      chatRoom,
      egressId: null,
      replay: null,
      expiresAt: null,
    };
    await store.put(record);
    const at = new AccessToken(this.deps.apiKey, this.deps.apiSecret, { identity: userId, name: userId, ttl: '12h' });
    at.addGrant(streamerGrant(roomName));
    return { record, token: await at.toJwt() };
  }

  async markLive(id: string, openIdToken: unknown): Promise<StreamRecord> {
    const record = await this.owned(id, openIdToken);
    if (record.state === 'live') return record;
    if (record.state !== 'starting') throw new Refusal(409, 'ended', 'This stream has ended');
    const now = Date.now();
    let live: StreamRecord = { ...record, state: 'live', liveAt: now };
    this.streamerSeen.set(id, now);
    try {
      const egressId = await this.deps.recorder.start(streamRoomName(id), record.owner, id);
      if (egressId) live = { ...live, egressId };
    } catch (err) {
      // The stream goes on; it just won't have a replay.
      console.error(`Stream ${id}: recording not started`, err);
    }
    await this.deps.store.put(live);
    return live;
  }

  async stop(id: string, openIdToken: unknown): Promise<StreamRecord> {
    const record = await this.owned(id, openIdToken);
    if (record.state === 'ended') return record;
    if (record.state === 'starting') {
      await this.drop(record);
      return { ...record, state: 'ended', endedAt: Date.now() };
    }
    return this.end(record);
  }

  async setThumbnail(id: string, header: unknown, type: string | undefined, body: unknown): Promise<void> {
    const record = await this.owned(id, openIdFromHeader(header));
    if (record.state === 'ended') throw new Refusal(409, 'ended', 'This stream has ended');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new Refusal(400, 'bad_picture', 'Send a JPEG or WebP picture');
    const jpeg = type === 'image/jpeg' && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    const webp = type === 'image/webp' && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!jpeg && !webp) throw new Refusal(400, 'bad_picture', 'Send a JPEG or WebP picture');
    this.thumbnails.set(id, { type: type!, data: Buffer.from(body) });
  }

  // --- Watching --------------------------------------------------------------------------------

  /** A viewer token, under the cap. `resume` is the identity a viewer had, to come back as after a drop. */
  async viewerToken(id: string, openIdToken: unknown, resume: unknown): Promise<{ token: string; roomName: string; identity: string }> {
    const record = await this.visible(id);
    if (!record || record.state !== 'live') throw new Refusal(404, 'not_found', 'This stream isn’t live');
    const signedIn = openIdToken ? await this.who(openIdToken) : undefined;
    const now = Date.now();
    const rooms = await this.peopleInLiveRooms();
    const present = new Set(rooms.find((room) => room.id === id)?.people.map((p) => p.identity));
    // Coming back as who they were is only for someone still in the room, and only as themselves.
    const resumable =
      typeof resume === 'string' && present.has(resume) && (signedIn ? resume.startsWith(`${signedIn}#`) : isGuestIdentity(resume));
    const identity = resumable ? resume : signedIn ? `${signedIn}#${randomBytes(4).toString('hex')}` : guestIdentity();
    this.pending = this.pending.filter((token) => now - token.at < 30_000);
    const verdict = admitViewer(countViewers(rooms, this.pending, now), this.deps.settings, !signedIn, resumable);
    if (verdict !== 'ok') {
      throw new Refusal(503, verdict, verdict === 'guest_full' ? 'This stream is full for people who aren’t signed in' : 'This server’s streams are full right now');
    }
    if (!resumable) this.pending.push({ identity, at: now });
    const roomName = streamRoomName(id);
    const at = new AccessToken(this.deps.apiKey, this.deps.apiSecret, { identity, name: signedIn ?? 'Guest', ttl: VIEWER_TOKEN_TTL_S });
    at.addGrant(viewerGrant(roomName));
    return { token: await at.toJwt(), roomName, identity };
  }

  private async peopleInLiveRooms() {
    const live = this.deps.store.all().filter((r) => r.state === 'live');
    return Promise.all(
      live.map(async (record) => {
        const participants = await this.deps.rooms.listParticipants(streamRoomName(record.id)).catch(() => []);
        // Egress joins as a participant of kind EGRESS (2).
        const people = participants.map((p) => ({ identity: p.identity, recorder: Number(p.kind) === 2 }));
        return { id: record.id, owner: record.owner, people };
      })
    );
  }

  async chat(id: string, after: number | undefined): Promise<{ messages: ChatMessage[]; authors: Record<string, { userId: string; avatarUrl?: string }> }> {
    const record = await this.visible(id);
    if (!record?.chatRoom) throw new Refusal(404, 'not_found', 'No chat for this stream');
    const now = Date.now();
    let cached = this.chatCache.get(id);
    if (!cached || now - cached.at > CHAT_CACHE_MS) {
      const mx = await this.deps.mx();
      const page = await mx.createMessagesRequest(record.chatRoom, null, 100, Direction.Backward);
      cached = { at: now, messages: chatMessages(page.chunk as RawEvent[]) };
      this.chatCache.set(id, cached);
    }
    const messages = cached.messages.filter((m) => after === undefined || m.ts > after).slice(-50);
    const authors = Object.fromEntries(await Promise.all([...new Set(messages.map((m) => m.sender))].map(async (userId) => [userId, await this.author(userId)] as const)));
    return { messages, authors };
  }

  private async author(userId: string): Promise<{ userId: string; avatarUrl?: string }> {
    const cached = this.avatars.get(userId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return { userId, ...(cached.avatarUrl && { avatarUrl: cached.avatarUrl }) };
    const mx = await this.deps.mx();
    const info = await mx.getProfileInfo(userId, 'avatar_url').catch(() => ({}) as { avatar_url?: string });
    const avatarUrl = isMxc(info.avatar_url) ? info.avatar_url : undefined;
    if (this.avatars.size > 5000) this.avatars.delete(this.avatars.keys().next().value!);
    this.avatars.set(userId, { at: Date.now(), avatarUrl });
    return { userId, ...(avatarUrl && { avatarUrl }) };
  }

  // --- The chat room ---------------------------------------------------------------------------

  private async makeChatRoom(id: string, owner: string, title: string, watchUrl: string): Promise<string> {
    const mx = await this.deps.mx();
    const { room_id } = await mx.createRoom({
      name: [...`${title} · live chat`].slice(0, 200).join(''),
      topic: watchUrl,
      visibility: Visibility.Private,
      preset: Preset.PublicChat,
      power_level_content_override: chatPowerLevels(mx.getUserId()!, owner),
      initial_state: [
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
        { type: STREAM_CHAT_EVENT, state_key: '', content: { stream_id: id, owner } },
      ],
    });
    return room_id;
  }

  /** At the end: nobody but the streamer and the bot may write, and the whole chat goes to the log. */
  private async closeChatForWriting(record: StreamRecord): Promise<void> {
    if (!record.chatRoom) return;
    const mx = await this.deps.mx();
    try {
      const levels = (await mx.getStateEvent(record.chatRoom, 'm.room.power_levels', '')) as Record<string, unknown>;
      // matrix-js-sdk's typing wants a known state event; power levels are one.
      await mx.sendStateEvent(record.chatRoom, 'm.room.power_levels' as never, { ...levels, events_default: 50 } as never, '');
    } catch (err) {
      console.warn(`Stream ${record.id}: chat not made read-only`, err);
    }
    try {
      const events: RawEvent[] = [];
      let from: string | null = null;
      do {
        const page = await mx.createMessagesRequest(record.chatRoom, from, 1000, Direction.Backward);
        events.push(...(page.chunk as RawEvent[]));
        from = page.end && page.chunk.length ? page.end : null;
      } while (from && events.length < CHAT_LOG_MAX_EVENTS);
      const dir = join(this.deps.dataDir, 'streams', record.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'chat.jsonl'), chatLogText(chatMessages(events)));
    } catch (err) {
      console.error(`Stream ${record.id}: chat log not written`, err);
    }
  }

  /** When it expires: nobody can join, everyone is removed, and the bot leaves. */
  private async closeChatRoom(roomId: string | null): Promise<void> {
    if (!roomId) return;
    const mx = await this.deps.mx();
    const bot = mx.getUserId();
    try {
      await mx.sendStateEvent(roomId, 'm.room.join_rules' as never, { join_rule: 'invite' } as never, '');
      const { joined } = await mx.getJoinedRoomMembers(roomId);
      for (const userId of Object.keys(joined)) if (userId !== bot) await mx.kick(roomId, userId, 'This stream’s replay has expired').catch(() => undefined);
      await mx.leave(roomId);
    } catch (err) {
      console.warn(`Chat room ${roomId} not closed`, err);
    }
  }

  // --- Ending and expiring ---------------------------------------------------------------------

  async end(record: StreamRecord): Promise<StreamRecord> {
    const ended = endedRecord(record, Date.now(), this.deps.settings);
    await this.deps.store.put(ended);
    this.viewers.delete(record.id);
    this.streamerSeen.delete(record.id);
    // Disconnects everyone; the replay takes over on the watch page.
    await this.deps.rooms.deleteRoom(streamRoomName(record.id)).catch(() => undefined);
    if (ended.egressId) await this.deps.recorder.stop(ended.egressId);
    // After the answer: the log can take a while. Deleting the stream waits for it (expire).
    const finishing = this.closeChatForWriting(ended).finally(() => this.finishing.delete(record.id));
    this.finishing.set(record.id, finishing);
    return ended;
  }

  /** A stream that never went live: gone as if it never was. */
  private async drop(record: StreamRecord): Promise<void> {
    await this.deps.store.remove(record.id);
    this.thumbnails.delete(record.id);
    await this.deps.rooms.deleteRoom(streamRoomName(record.id)).catch(() => undefined);
    await this.closeChatRoom(record.chatRoom);
  }

  /** Deletes a stream's replay, chat log and record, and closes its chat room. */
  async expire(record: StreamRecord): Promise<void> {
    if (record.state === 'live') await this.end(record);
    await this.finishing.get(record.id);
    if (record.egressId) await this.deps.recorder.stop(record.egressId);
    await this.deps.recorder.remove(record.id);
    await rm(join(this.deps.dataDir, 'streams', record.id), { recursive: true, force: true });
    this.thumbnails.delete(record.id);
    this.chatCache.delete(record.id);
    await this.deps.store.remove(record.id);
    await this.closeChatRoom(record.chatRoom);
  }

  /** Every 15 s: who's in each live room, what's due, and whether recordings have finished. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const room of await this.peopleInLiveRooms()) {
        if (room.people.some((p) => p.identity === room.owner)) this.streamerSeen.set(room.id, now);
        this.viewers.set(room.id, room.people.filter((p) => !p.recorder && p.identity !== room.owner).length);
      }
      for (const record of this.deps.store.all()) {
        const action = dueAction(record, now, this.deps.settings, this.streamerSeen.get(record.id));
        if (action === 'drop') await this.drop(record);
        else if (action === 'end') await this.end(record);
        else if (action === 'expire') await this.expire(record);
        else if (record.state === 'ended' && record.egressId && !record.replay) await this.checkRecording(record);
      }
    } catch (err) {
      console.error('Stream sweep failed', err);
    } finally {
      this.sweeping = false;
    }
  }

  private async checkRecording(record: StreamRecord): Promise<void> {
    const result = await this.deps.recorder.result(record.egressId!, record.id).catch(() => ({ status: 'running' }) as const);
    if (result.status === 'running') return;
    if (result.status === 'failed') console.warn(`Stream ${record.id}: no replay, the recording failed`);
    await this.deps.store.put({ ...record, egressId: null, replay: result.status === 'done' ? result.replay : null });
  }

  // --- Files -----------------------------------------------------------------------------------

  async downloadLinks(id: string, openIdToken: unknown): Promise<{ replay?: string; chat?: string }> {
    const record = await this.owned(id, openIdToken);
    if (record.state !== 'ended') throw new Refusal(409, 'not_ended', 'Downloads are there once the stream ends');
    const expires = Date.now() + DOWNLOAD_LINK_MS;
    const link = (kind: DownloadKind) => `/api/public/streams/${id}/files/${kind}?expires=${expires}&sig=${downloadSignature(this.secret, id, kind, expires)}`;
    const chatThere = await stat(this.chatLogPath(id)).then(
      () => true,
      () => false
    );
    return { ...(record.replay && { replay: link('replay') }), ...(chatThere && { chat: link('chat') }) };
  }

  mayDownload(id: string, kind: DownloadKind, expires: unknown, sig: unknown): boolean {
    return isStreamId(id) && downloadAllowed(this.secret, id, kind, expires, sig, Date.now());
  }

  chatLogPath(id: string): string {
    return join(this.deps.dataDir, 'streams', id, 'chat.jsonl');
  }

  thumbnail(id: string) {
    return this.thumbnails.get(id);
  }

  record(id: string) {
    return this.deps.store.get(id);
  }

  replayPath(id: string): string {
    return this.deps.recorder.replayPath(id);
  }

  // --- For routes ------------------------------------------------------------------------------

  async publicOne(id: string) {
    const record = await this.visible(id);
    return record && this.shape(record);
  }

  async listing(owner: string | undefined) {
    const hidden = await this.deps.hidden();
    return streamListing(this.deps.store.all(), Date.now(), owner)
      .filter((record) => !hidden.has(record.owner))
      .map((record) => this.shape(record));
  }

  /** The card for `/@name/live/<id>`: undefined when the stream isn't public or isn't theirs. */
  async card(rawUser: string, id: string) {
    const record = await this.visible(id);
    if (!record || localUserId(rawUser, await this.deps.serverName()) !== record.owner) return undefined;
    return { record, hasThumbnail: this.thumbnails.has(id) };
  }

  async localUser(raw: string): Promise<string | undefined> {
    return localUserId(raw, await this.deps.serverName());
  }

  get livekitUrl(): string {
    return this.deps.livekitUrl;
  }

  /** `purrlor streams`: everything, starting ones too. */
  all(): StreamRecord[] {
    return this.deps.store.all();
  }

  viewersOf(id: string): number | undefined {
    return this.viewers.get(id);
  }
}

// --- HTTP --------------------------------------------------------------------------------------

function limited(req: Request, res: Response, limiter: RateLimiter): boolean {
  if (limiter.take(clientIp(req))) return false;
  res.status(429).json({ error: 'Too many requests; slow down', code: 'rate_limited' });
  return true;
}

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof Refusal) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`Streams: ${what} failed`, err);
  res.status(503).json({ error: 'Not available right now', code: 'unavailable' });
}

async function sendFile(req: Request, res: Response, path: string, type: string, disposition: string): Promise<void> {
  const size = await stat(path).then(
    (s) => s.size,
    () => -1
  );
  if (size < 0) {
    res.status(404).json({ error: 'Not found', code: 'not_found' });
    return;
  }
  res.set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Disposition': disposition, 'X-Content-Type-Options': 'nosniff' });
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.status(416).set('Content-Range', `bytes */${size}`).end();
    return;
  }
  if (range) {
    res.status(206).set({ 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) });
    await pipeline(createReadStream(path, { start: range.start, end: range.end }), res);
  } else {
    res.status(200).set('Content-Length', String(size));
    await pipeline(createReadStream(path), res);
  }
}

export function streamsRouter(streams: Streams): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    if (limited(req, res, tokenLimiter)) return;
    try {
      const { record, token } = await streams.goLive(req.body?.openid_token, req.body?.title, baseUrl(req));
      res.status(201).json({ stream: publicStream(record, { hasThumbnail: false }), token, url: streams.livekitUrl });
    } catch (err) {
      fail(res, err, 'going live');
    }
  });

  router.get('/', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      let owner: string | undefined;
      if (typeof req.query.owner === 'string') {
        owner = await streams.localUser(req.query.owner);
        if (!owner) return void res.json({ streams: [] });
      }
      res.set('Cache-Control', 'public, max-age=10').json({ streams: await streams.listing(owner) });
    } catch (err) {
      fail(res, err, 'listing');
    }
  });

  router.get('/:id', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      const stream = await streams.publicOne(req.params.id);
      if (!stream) return void res.status(404).json({ error: 'No such stream', code: 'not_found' });
      res.set('Cache-Control', 'public, max-age=10').json({ stream });
    } catch (err) {
      fail(res, err, 'reading a stream');
    }
  });

  router.post('/:id/live', async (req, res) => {
    try {
      res.json({ stream: publicStream(await streams.markLive(req.params.id, req.body?.openid_token), { hasThumbnail: !!streams.thumbnail(req.params.id) }) });
    } catch (err) {
      fail(res, err, 'going live');
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      res.json({ stream: publicStream(await streams.stop(req.params.id, req.body?.openid_token), { hasThumbnail: !!streams.thumbnail(req.params.id) }) });
    } catch (err) {
      fail(res, err, 'stopping');
    }
  });

  router.put('/:id/thumbnail', express.raw({ type: ['image/jpeg', 'image/webp'], limit: THUMBNAIL_MAX_BYTES }), async (req, res) => {
    try {
      await streams.setThumbnail(req.params.id, req.headers.authorization, req.headers['content-type']?.split(';')[0].trim(), req.body);
      res.status(204).end();
    } catch (err) {
      fail(res, err, 'a thumbnail');
    }
  });

  router.get('/:id/thumbnail', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    const picture = (await streams.publicOne(req.params.id).catch(() => undefined)) && streams.thumbnail(req.params.id);
    if (!picture) return void res.status(404).json({ error: 'No thumbnail', code: 'not_found' });
    res.set({ 'Content-Type': picture.type, 'Cache-Control': 'public, max-age=30', 'X-Content-Type-Options': 'nosniff' }).send(picture.data);
  });

  router.post('/:id/token', async (req, res) => {
    if (limited(req, res, tokenLimiter)) return;
    try {
      const { token, roomName, identity } = await streams.viewerToken(req.params.id, req.body?.openid_token, req.body?.resume);
      res.set('Cache-Control', 'no-store').json({ token, roomName, identity, url: streams.livekitUrl });
    } catch (err) {
      fail(res, err, 'a viewer token');
    }
  });

  router.get('/:id/chat', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      const after = typeof req.query.after === 'string' && /^\d{1,16}$/.test(req.query.after) ? Number(req.query.after) : undefined;
      res.set('Cache-Control', 'no-store').json(await streams.chat(req.params.id, after));
    } catch (err) {
      fail(res, err, 'reading chat');
    }
  });

  router.get('/:id/replay', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      const stream = await streams.publicOne(req.params.id);
      if (!stream?.replay) return void res.status(404).json({ error: 'No replay', code: 'not_found' });
      res.set('Cache-Control', 'private, max-age=600');
      await sendFile(req, res, streams.replayPath(req.params.id), 'video/mp4', 'inline');
    } catch (err) {
      if (!res.headersSent) fail(res, err, 'a replay');
    }
  });

  router.post('/:id/download', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(await streams.downloadLinks(req.params.id, req.body?.openid_token));
    } catch (err) {
      fail(res, err, 'download links');
    }
  });

  router.get('/:id/files/:kind', async (req, res) => {
    const { id, kind } = req.params;
    if ((kind !== 'replay' && kind !== 'chat') || !streams.mayDownload(id, kind, req.query.expires, req.query.sig)) {
      return void res.status(403).json({ error: 'This download link isn’t valid or has run out', code: 'bad_link' });
    }
    try {
      res.set('Cache-Control', 'no-store');
      if (kind === 'replay') await sendFile(req, res, streams.replayPath(id), 'video/mp4', `attachment; filename="${id}.mp4"`);
      else await sendFile(req, res, streams.chatLogPath(id), 'application/x-ndjson; charset=utf-8', `attachment; filename="${id}-chat.jsonl"`);
    } catch (err) {
      if (!res.headersSent) fail(res, err, 'a download');
    }
  });

  return router;
}

/** `GET /api/public/card/:user/live/:id`: the link preview for a watch page. */
export function streamCardHandler(streams: Streams, siteName: () => Promise<string>) {
  return async (req: Request, res: Response) => {
    if (limited(req, res, readLimiter)) return;
    const base = baseUrl(req);
    const site = await siteName().catch(() => 'Purrlor');
    const found = await streams.card(req.params.user, req.params.id).catch(() => undefined);
    const card = found
      ? {
          title: found.record.title,
          description: found.record.state === 'live' ? `Live now · ${found.record.owner}` : `Replay · ${found.record.owner}`,
          url: `${base}/@${req.params.user.replace(/^@/, '')}/live/${found.record.id}`,
          ...(found.hasThumbnail && { image: `${base}/api/public/streams/${found.record.id}/thumbnail` }),
          siteName: site,
        }
      : { title: 'Sign in to see this stream', description: site, url: base, siteName: site };
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }).send(linkCardHtml(card));
  };
}
