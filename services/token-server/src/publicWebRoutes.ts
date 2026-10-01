import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import type { MatrixClient } from 'matrix-js-sdk';
import { adminStore } from './adminStore.js';
import { pageStateFromRoom, type ControlDeps, type PageState } from './controlServer.js';
import { getServiceClient } from './membership.js';
import { byteLimit, MediaCache, TooLargeError } from './mediaCache.js';
import {
  addRoomMedia,
  isMxc,
  isSeekableMediaType,
  isServableMediaType,
  linkCardHtml,
  localUserId,
  MediaIndex,
  mayServeMedia,
  pageOfPosts,
  parseRange,
  PROFILE_ROOM_TYPE,
  publicPageContent,
  publicPostsFromTimeline,
  readFollows,
  readPageContent,
  readProfileOwner,
  readPublicWeb,
  serverNameOf,
  splitMxc,
  type MediaSource,
  type PublicPost,
  type RawEvent,
} from './publicWeb.js';
import { RateLimiter } from './webhooks.js';

/**
 * The public web's HTTP side (publicWeb.ts has the rules). Everything here is read-only, needs no
 * sign-in, and is answered from what the service account can read anyway: profile rooms are
 * world-readable and listed in the room directory, which is how the web client's global feed finds
 * them too.
 *
 *   GET /api/public/pages/:user           a profile page, if its owner opted in
 *   GET /api/public/feed?before=&author=  Global posts, newest first
 *   GET /api/public/posts/:eventId        one Global post
 *   GET /api/public/status/:user          { hidden } — whether an admin hid this person's page
 *   GET /api/public/media/:server/:id     media a public answer referenced (?width=&height= for a thumbnail)
 *   GET /api/public/card/:user            link-preview HTML for /@name (nginx sends unfurling bots here)
 *   GET /api/public/card/post/:eventId    the same for a post's link
 */

/** How long the feed is reused before profile rooms are read again. */
const FEED_TTL_MS = 60_000;
/** Most profile rooms read per refresh: 10 directory pages of 50. */
const MAX_PROFILE_ROOMS = 500;
/** Each profile room's most recent events read per refresh, posts and their likes and comments. */
const EVENTS_PER_ROOM = 100;
const FEED_PAGE_SIZE = 20;
const READ_CONCURRENCY = 4;

const PUBLIC_URL = process.env.PUBLIC_WEB_URL?.replace(/\/+$/, '');
const MiB = 1024 * 1024;
/** The largest file the media route hands out; bigger ones are refused, not cut short. */
const MAX_MEDIA_BYTES = Number(process.env.PUBLIC_MEDIA_MAX_BYTES) > 0 ? Number(process.env.PUBLIC_MEDIA_MAX_BYTES) : 100 * MiB;
/** Disk the local copies of sound and video may take (mediaCache.ts). */
const MEDIA_CACHE_BYTES = Number(process.env.PUBLIC_MEDIA_CACHE_BYTES) > 0 ? Number(process.env.PUBLIC_MEDIA_CACHE_BYTES) : 1024 * MiB;
/**
 * How long browsers and caches in between may keep a file. Short, so a takedown sticks: the route
 * refuses a blocked file at once, but can't reach into copies already handed out.
 */
const MEDIA_MAX_AGE_S = 600;

export type ProfileRoom = { roomId: string; owner: string; state: RawEvent[]; posts: PublicPost[] };
/** `publicPages`: owners whose page switch is on in this snapshot. */
export type FeedCache = { at: number; rooms: Map<string, ProfileRoom>; byOwner: Map<string, ProfileRoom>; publicPages: Set<string> };

export const mediaIndex = new MediaIndex();
export const mediaCache = new MediaCache(join(process.env.PURRLOR_DATA_DIR ?? '/data', 'media-cache'), MAX_MEDIA_BYTES, MEDIA_CACHE_BYTES);
// Generous for a person browsing (a feed page, its images), tight for a scraper.
const pageLimiter = new RateLimiter(60, 120);
const mediaLimiter = new RateLimiter(200, 600);

let feedCache: FeedCache | undefined;
let feedRefresh: Promise<FeedCache> | undefined;

/** Hidden people (`purrlor pages hide`): their page and their posts are gone from the public web. */
async function hiddenUsers(): Promise<Set<string>> {
  return (await adminStore.lists()).hidden;
}

// --- Reading profile rooms ---------------------------------------------------------------------

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    })
  );
  return results;
}

async function listProfileRoomIds(mx: MatrixClient): Promise<string[]> {
  const ids: string[] = [];
  let since: string | undefined;
  while (ids.length < MAX_PROFILE_ROOMS) {
    const page = await mx.publicRooms({ limit: 50, ...(since && { since }), filter: { room_types: [PROFILE_ROOM_TYPE as any] } });
    for (const entry of page.chunk) {
      if (entry.room_type === PROFILE_ROOM_TYPE && entry.world_readable) ids.push(entry.room_id);
    }
    if (!page.next_batch || page.chunk.length === 0) break;
    since = page.next_batch;
  }
  return ids.slice(0, MAX_PROFILE_ROOMS);
}

async function readProfileRoom(mx: MatrixClient, roomId: string, serverName: string): Promise<ProfileRoom | undefined> {
  try {
    const state = (await mx.roomState(roomId)) as unknown as RawEvent[];
    const owner = readProfileOwner(state);
    if (!owner || serverNameOf(owner) !== serverName) return undefined;
    // Straight to /messages: the SDK's createMessagesRequest wants a Filter instance, and given a
    // plain filter it throws before asking, which read every room as empty.
    const filter = JSON.stringify({ types: ['xyz.nekous.post', 'xyz.nekous.comment', 'm.reaction'] });
    const query = new URLSearchParams({ dir: 'b', limit: String(EVENTS_PER_ROOM), filter });
    const res = await fetch(`${mx.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query}`, {
      headers: { Authorization: `Bearer ${mx.getAccessToken()}` },
    });
    if (!res.ok) throw new Error(`messages: HTTP ${res.status}`);
    const page = (await res.json()) as { chunk?: RawEvent[] };
    return { roomId, owner, state, posts: publicPostsFromTimeline(Array.isArray(page.chunk) ? page.chunk : [], owner) };
  } catch (err) {
    console.error(`Public web: couldn't read profile room ${roomId}: ${(err as Error).message}`);
    return undefined;
  }
}

async function refreshFeed(): Promise<FeedCache> {
  const mx = await getServiceClient();
  const serverName = serverNameOf(mx.getUserId() ?? '');
  const ids = await listProfileRoomIds(mx);
  const rooms = (await mapLimited(ids, READ_CONCURRENCY, (id) => readProfileRoom(mx, id, serverName))).filter(
    (room): room is ProfileRoom => !!room
  );
  const cache: FeedCache = { at: Date.now(), rooms: new Map(rooms.map((room) => [room.roomId, room])), byOwner: new Map(), publicPages: new Set() };
  // A person has one profile room; if a stray second one exists, the one with posts wins.
  for (const room of rooms) {
    const current = cache.byOwner.get(room.owner);
    if (!current || room.posts.length > current.posts.length) cache.byOwner.set(room.owner, room);
  }
  for (const room of cache.byOwner.values()) if (readPublicWeb(room.state)) cache.publicPages.add(room.owner);
  // The files the public web may serve are exactly the ones these rooms name now.
  const snapshot = new Map<string, MediaSource[]>();
  for (const room of cache.byOwner.values()) addRoomMedia(snapshot, room);
  mediaIndex.setSnapshot(snapshot);
  return cache;
}

/** The feed, reused for a minute. A stale one is served while a fresh one is read behind it. */
export async function getFeed(): Promise<FeedCache> {
  const stale = !feedCache || Date.now() - feedCache.at > FEED_TTL_MS;
  if (stale && !feedRefresh) {
    feedRefresh = refreshFeed()
      .then((cache) => (feedCache = cache))
      .finally(() => (feedRefresh = undefined));
  }
  if (feedCache) return feedCache;
  return feedRefresh!;
}

export async function serverName(): Promise<string> {
  return serverNameOf((await getServiceClient()).getUserId() ?? '');
}

// --- Shaping answers ---------------------------------------------------------------------------

type PublicAuthor = { userId: string; avatarUrl?: string };

const avatarCache = new Map<string, { at: number; avatarUrl?: string }>();

/** Avatar and username only: that's all a Global post says about its author. */
async function authorOf(mx: MatrixClient, userId: string): Promise<PublicAuthor> {
  const cached = avatarCache.get(userId);
  if (cached && Date.now() - cached.at < FEED_TTL_MS * 5) return { userId, ...(cached.avatarUrl && { avatarUrl: cached.avatarUrl }) };
  const info = await mx.getProfileInfo(userId, 'avatar_url').catch(() => ({}) as { avatar_url?: string });
  const avatarUrl = isMxc(info.avatar_url) ? info.avatar_url : undefined;
  avatarCache.set(userId, { at: Date.now(), avatarUrl });
  if (avatarCache.size > 5000) avatarCache.delete(avatarCache.keys().next().value!);
  return { userId, ...(avatarUrl && { avatarUrl }) };
}

async function withAuthors(mx: MatrixClient, posts: PublicPost[]): Promise<{ posts: PublicPost[]; authors: Record<string, PublicAuthor> }> {
  const ids = new Set<string>();
  posts.forEach((post) => {
    ids.add(post.author);
    if (post.repost?.kind === 'global') ids.add(post.repost.author);
  });
  const authors = Object.fromEntries(await Promise.all([...ids].map(async (id) => [id, await authorOf(mx, id)] as const)));
  // The posts' own files are in the feed's media snapshot already; avatars come from profiles.
  for (const author of Object.values(authors)) if (author.avatarUrl) mediaIndex.allowProfile([author.avatarUrl], author.userId);
  return { posts, authors };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function limited(req: Request, res: Response, limiter: RateLimiter): boolean {
  if (limiter.take(clientIp(req))) return false;
  res.status(429).json({ error: 'Too many requests; slow down' });
  return true;
}

/** The one answer for "no such person", "not opted in" and "hidden by an admin". */
function notFound(res: Response): void {
  res.status(404).json({ error: 'Sign in to see this page', code: 'not_found' });
}

/** The public page for a user, or undefined (for every reason it might not be shown). */
async function publicPage(rawUser: string) {
  const name = await serverName();
  const userId = localUserId(rawUser, name);
  const lists = await adminStore.lists();
  if (!userId || lists.hidden.has(userId) || lists.publicOff.has(userId)) return undefined;
  const feed = await getFeed();
  const room = feed.byOwner.get(userId);
  if (!room || !readPublicWeb(room.state)) return undefined;
  const mx = await getServiceClient();
  const profile = (await mx.getProfileInfo(userId).catch(() => ({}))) as Record<string, unknown>;
  const pick = (key: string) => (typeof profile[key] === 'string' ? (profile[key] as string) : undefined);
  const avatarUrl = isMxc(profile.avatar_url) ? profile.avatar_url : undefined;
  const bannerUrl = isMxc(profile['xyz.nekous.banner_url']) ? (profile['xyz.nekous.banner_url'] as string) : undefined;
  // Top 8, signed out: a friend whose own page is public and who follows this person back.
  const friendShown = (friend: string) => {
    const theirs = feed.byOwner.get(friend);
    return (
      !!theirs &&
      feed.publicPages.has(friend) &&
      !lists.hidden.has(friend) &&
      !lists.publicOff.has(friend) &&
      readFollows(theirs.state, friend).has(userId)
    );
  };
  const content = readPageContent(room.state);
  return {
    userId,
    displayName: pick('displayname')?.slice(0, 100),
    avatarUrl,
    avatarAnimated: profile['xyz.nekous.avatar_animated'] === true,
    bannerUrl,
    bio: pick('xyz.nekous.bio')?.slice(0, 1000),
    page: content ? publicPageContent(content, friendShown) : null,
  };
}

/** A page answer's avatar and banner, which come from the profile rather than the page's room. */
function allowProfileMedia(page: { userId: string; avatarUrl?: string; bannerUrl?: string }): void {
  if (page.avatarUrl) mediaIndex.allowProfile([page.avatarUrl], page.userId, 'profile');
  if (page.bannerUrl) mediaIndex.allowProfile([page.bannerUrl], page.userId, 'page');
}

const MEDIA_HEADERS = {
  'Cache-Control': `public, max-age=${MEDIA_MAX_AGE_S}`,
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Cross-Origin-Resource-Policy': 'same-site',
};

/** A local copy (sound, video), whole or the one range asked for. */
async function sendCopy(req: Request, res: Response, copy: { path: string; size: number; type: string }): Promise<void> {
  res.set({ ...MEDIA_HEADERS, 'Content-Type': copy.type, 'Accept-Ranges': 'bytes' });
  const range = parseRange(req.get('range'), copy.size);
  if (range === 'unsatisfiable') return void res.status(416).set('Content-Range', `bytes */${copy.size}`).end();
  const { start, end } = range ?? { start: 0, end: copy.size - 1 };
  if (range) res.status(206).set('Content-Range', `bytes ${start}-${end}/${copy.size}`);
  res.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (req.method === 'HEAD' || copy.size === 0) return void res.end();
  await pipeline(createReadStream(copy.path, { start, end }), res);
}

function baseUrl(req: Request): string {
  return PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
}

function mediaUrl(req: Request, mxc: string, size?: number): string | undefined {
  const parts = splitMxc(mxc);
  if (!parts) return undefined;
  return `${baseUrl(req)}/api/public/media/${parts.server}/${parts.mediaId}${size ? `?width=${size}&height=${size}` : ''}`;
}

// --- Routes ------------------------------------------------------------------------------------

export function publicWebRouter(): Router {
  const router = Router();

  router.get('/pages/:user', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    try {
      const page = await publicPage(req.params.user);
      if (!page) return notFound(res);
      allowProfileMedia(page);
      res.set('Cache-Control', 'public, max-age=60').json(page);
    } catch (err) {
      console.error('Public page failed', err);
      res.status(503).json({ error: 'Not available right now' });
    }
  });

  router.get('/feed', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    try {
      const before = typeof req.query.before === 'string' && /^\d{1,16}$/.test(req.query.before) ? Number(req.query.before) : undefined;
      const feed = await getFeed();
      const hiddenSet = await hiddenUsers();
      let posts = [...feed.byOwner.values()].flatMap((room) => (hiddenSet.has(room.owner) ? [] : room.posts));
      if (typeof req.query.author === 'string') {
        const author = localUserId(req.query.author, await serverName());
        posts = author ? posts.filter((post) => post.author === author) : [];
      }
      const page = pageOfPosts(posts, before, FEED_PAGE_SIZE);
      const mx = await getServiceClient();
      res.set('Cache-Control', 'public, max-age=30').json({ ...(await withAuthors(mx, page.posts)), ...(page.next && { next: page.next }) });
    } catch (err) {
      console.error('Public feed failed', err);
      res.status(503).json({ error: 'Not available right now' });
    }
  });

  router.get('/posts/:eventId', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    try {
      const post = await findPost(req.params.eventId);
      if (!post) return void res.status(404).json({ error: 'Sign in to see this post', code: 'not_found' });
      const mx = await getServiceClient();
      res.set('Cache-Control', 'public, max-age=60').json(await withAuthors(mx, [post]));
    } catch (err) {
      console.error('Public post failed', err);
      res.status(503).json({ error: 'Not available right now' });
    }
  });

  router.get('/status/:user', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    const userId = localUserId(req.params.user, await serverName().catch(() => ''));
    const lists = await adminStore.lists();
    res
      .set('Cache-Control', 'no-store')
      .json({ hidden: !!userId && lists.hidden.has(userId), publicOff: !!userId && lists.publicOff.has(userId) });
  });

  router.get('/media/:server/:mediaId', async (req, res) => {
    if (limited(req, res, mediaLimiter)) return;
    const mxc = `mxc://${req.params.server}/${req.params.mediaId}`;
    if (!isMxc(mxc)) return void res.status(404).end();
    try {
      const feed = await getFeed();
      if (!mayServeMedia(mxc, mediaIndex.sources(mxc), await adminStore.lists(), feed.publicPages)) return void res.status(404).end();
      const width = Number(req.query.width);
      const height = Number(req.query.height);
      const thumbnail = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 1600 && height <= 1600;

      const copy = thumbnail ? undefined : mediaCache.get(mxc);
      if (copy) return void (await sendCopy(req, res, copy));

      const mx = await getServiceClient();
      const path = thumbnail
        ? `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(req.params.server)}/${encodeURIComponent(req.params.mediaId)}?width=${width}&height=${height}&method=scale&animated=true`
        : `/_matrix/client/v1/media/download/${encodeURIComponent(req.params.server)}/${encodeURIComponent(req.params.mediaId)}`;
      const upstream = await fetch(`${mx.baseUrl}${path}`, { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } });
      const type = upstream.headers.get('content-type');
      const length = Number(upstream.headers.get('content-length') ?? NaN);
      if (!upstream.ok || !upstream.body || !isServableMediaType(type) || length > MAX_MEDIA_BYTES) {
        void upstream.body?.cancel().catch(() => undefined);
        return void res.status(404).end();
      }

      // Sound and video: copied here first, so ranges work and the size is known before sending.
      if (!thumbnail && isSeekableMediaType(type)) {
        const stored = await mediaCache.store(mxc, type!, upstream.body as never).catch((err: unknown) => {
          if (err instanceof TooLargeError) return undefined;
          throw err;
        });
        if (!stored) return void res.status(404).end();
        return void (await sendCopy(req, res, stored));
      }

      res.set({ ...MEDIA_HEADERS, 'Content-Type': type! });
      if (Number.isFinite(length)) res.set('Content-Length', String(length));
      await pipeline(Readable.fromWeb(upstream.body as never), byteLimit(MAX_MEDIA_BYTES), res).catch((err: unknown) => {
        // Over the limit part-way through (the homeserver gave no length): cut off, never finished.
        if (!(err instanceof TooLargeError)) throw err;
        res.destroy();
      });
    } catch (err) {
      console.error('Public media failed', err);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }
  });

  router.get('/card/post/:eventId', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    try {
      const post = await findPost(req.params.eventId);
      const name = await serverName();
      if (!post) return void sendCard(res, { title: `Purrlor on ${name}`, description: 'Sign in to see this post.', url: baseUrl(req), siteName: 'Purrlor' });
      const mx = await getServiceClient();
      const { authors } = await withAuthors(mx, [post]);
      const author = authors[post.author];
      const image = post.attachments?.find((a) => a.kind === 'image')?.url ?? author?.avatarUrl;
      sendCard(res, {
        title: `${post.author} on Purrlor`,
        description: post.warning ? `Content warning: ${post.warning}` : post.body || 'A post with media',
        url: `${baseUrl(req)}/@${post.author.slice(1, post.author.indexOf(':'))}/post/${encodeURIComponent(post.eventId)}`,
        ...(image && !post.sensitive && !post.warning && { image: mediaUrl(req, image, 600) }),
        siteName: 'Purrlor',
      });
    } catch {
      res.status(503).end();
    }
  });

  router.get('/card/:user', async (req, res) => {
    if (limited(req, res, pageLimiter)) return;
    try {
      const page = await publicPage(req.params.user);
      const name = await serverName();
      if (!page) {
        // Not opted in looks the same as nobody: a generic card.
        return void sendCard(res, { title: `Purrlor on ${name}`, description: 'Sign in to see this page.', url: baseUrl(req), siteName: 'Purrlor' });
      }
      allowProfileMedia(page);
      const style = page.page?.style as { colors?: { accent?: unknown } } | undefined;
      const localpart = page.userId.slice(1, page.userId.indexOf(':'));
      sendCard(res, {
        title: page.displayName ? `${page.displayName} (@${localpart})` : `@${localpart}`,
        description: page.bio ?? `${page.userId} on Purrlor`,
        url: `${baseUrl(req)}/@${localpart}`,
        ...(page.avatarUrl && { image: mediaUrl(req, page.avatarUrl, 400) }),
        ...(typeof style?.colors?.accent === 'string' && { themeColor: style.colors.accent }),
        siteName: 'Purrlor',
      });
    } catch {
      res.status(503).end();
    }
  });

  return router;
}

/**
 * What the admin control socket (controlServer.ts) needs from the public web. It reads the same
 * snapshot as the public routes, so what it reports is what signed-out visitors get.
 */
export function controlDeps(): Omit<ControlDeps, 'store'> {
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? '';
  const pageState = async (userId: string): Promise<PageState> => {
    const feed = await getFeed();
    const room = feed.byOwner.get(userId);
    return pageStateFromRoom(room?.state, feed.publicPages.has(userId));
  };
  return {
    serverName,
    homeserverUrl: () => homeserverUrl,
    pageState,
    async publicMediaOf(userId) {
      const feed = await getFeed();
      const mx = await getServiceClient();
      const profile = (await mx.getProfileInfo(userId).catch(() => ({}))) as Record<string, unknown>;
      const own = [profile.avatar_url, ...(feed.publicPages.has(userId) ? [profile['xyz.nekous.banner_url']] : [])].filter(isMxc);
      return [...new Set([...mediaIndex.ownedBy(userId), ...own])];
    },
    async profileRoomOwner(roomId) {
      return (await getFeed()).rooms.get(roomId)?.owner;
    },
    forgetCopy: (mxc) => mediaCache.forget(mxc),
  };
}

async function findPost(eventId: string): Promise<PublicPost | undefined> {
  if (!/^\$[A-Za-z0-9_\-+/=:.]{1,255}$/.test(eventId)) return undefined;
  const feed = await getFeed();
  const hiddenSet = await hiddenUsers();
  for (const room of feed.byOwner.values()) {
    if (hiddenSet.has(room.owner)) continue;
    const post = room.posts.find((p) => p.eventId === eventId);
    if (post) return post;
  }
  return undefined;
}

function sendCard(res: Response, card: Parameters<typeof linkCardHtml>[0]): void {
  res
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'; img-src *" })
    .send(linkCardHtml(card));
}
