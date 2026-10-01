import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { Direction, type MatrixClient } from 'matrix-js-sdk';
import { getServiceClient } from './membership.js';
import {
  collectMxc,
  isMxc,
  isServableMediaType,
  linkCardHtml,
  localUserId,
  MediaAllowlist,
  pageOfPosts,
  parseHiddenList,
  PROFILE_ROOM_TYPE,
  publicPostsFromTimeline,
  readPageContent,
  readProfileOwner,
  readPublicWeb,
  serverNameOf,
  splitMxc,
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

const HIDDEN_FILE = process.env.PUBLIC_WEB_HIDDEN_FILE ?? '/data/hidden-pages.txt';
const PUBLIC_URL = process.env.PUBLIC_WEB_URL?.replace(/\/+$/, '');

type ProfileRoom = { roomId: string; owner: string; state: RawEvent[]; posts: PublicPost[] };
type FeedCache = { at: number; rooms: Map<string, ProfileRoom>; byOwner: Map<string, ProfileRoom> };

const media = new MediaAllowlist();
// Generous for a person browsing (a feed page, its images), tight for a scraper.
const pageLimiter = new RateLimiter(60, 120);
const mediaLimiter = new RateLimiter(200, 600);

let feedCache: FeedCache | undefined;
let feedRefresh: Promise<FeedCache> | undefined;

// --- Admin hiding (a text file the `purrlor pages` command edits) ------------------------------

let hidden: { mtimeMs: number; checkedAt: number; users: Set<string> } = { mtimeMs: -1, checkedAt: 0, users: new Set() };

async function hiddenUsers(): Promise<Set<string>> {
  const now = Date.now();
  if (now - hidden.checkedAt < 10_000) return hidden.users;
  hidden.checkedAt = now;
  try {
    const { mtimeMs } = await stat(HIDDEN_FILE);
    if (mtimeMs !== hidden.mtimeMs) hidden = { mtimeMs, checkedAt: now, users: parseHiddenList(await readFile(HIDDEN_FILE, 'utf8')) };
  } catch {
    hidden = { mtimeMs: -1, checkedAt: now, users: new Set() };
  }
  return hidden.users;
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
    const filter = { types: ['xyz.nekous.post', 'xyz.nekous.comment', 'm.reaction'] };
    const page = await mx.createMessagesRequest(roomId, null, EVENTS_PER_ROOM, Direction.Backward, filter as any);
    return { roomId, owner, state, posts: publicPostsFromTimeline(page.chunk as unknown as RawEvent[], owner) };
  } catch {
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
  const cache: FeedCache = { at: Date.now(), rooms: new Map(rooms.map((room) => [room.roomId, room])), byOwner: new Map() };
  // A person has one profile room; if a stray second one exists, the one with posts wins.
  for (const room of rooms) {
    const current = cache.byOwner.get(room.owner);
    if (!current || room.posts.length > current.posts.length) cache.byOwner.set(room.owner, room);
  }
  return cache;
}

/** The feed, reused for a minute. A stale one is served while a fresh one is read behind it. */
async function getFeed(): Promise<FeedCache> {
  const stale = !feedCache || Date.now() - feedCache.at > FEED_TTL_MS;
  if (stale && !feedRefresh) {
    feedRefresh = refreshFeed()
      .then((cache) => (feedCache = cache))
      .finally(() => (feedRefresh = undefined));
  }
  if (feedCache) return feedCache;
  return feedRefresh!;
}

async function serverName(): Promise<string> {
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
  media.allow(collectMxc(posts));
  media.allow(collectMxc(authors));
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
  if (!userId || (await hiddenUsers()).has(userId)) return undefined;
  const feed = await getFeed();
  const room = feed.byOwner.get(userId);
  if (!room || !readPublicWeb(room.state)) return undefined;
  const mx = await getServiceClient();
  const profile = (await mx.getProfileInfo(userId).catch(() => ({}))) as Record<string, unknown>;
  const pick = (key: string) => (typeof profile[key] === 'string' ? (profile[key] as string) : undefined);
  const avatarUrl = isMxc(profile.avatar_url) ? profile.avatar_url : undefined;
  const bannerUrl = isMxc(profile['xyz.nekous.banner_url']) ? (profile['xyz.nekous.banner_url'] as string) : undefined;
  return {
    userId,
    displayName: pick('displayname')?.slice(0, 100),
    avatarUrl,
    avatarAnimated: profile['xyz.nekous.avatar_animated'] === true,
    bannerUrl,
    bio: pick('xyz.nekous.bio')?.slice(0, 1000),
    page: readPageContent(room.state) ?? null,
  };
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
      media.allow(collectMxc(page));
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
    res.set('Cache-Control', 'no-store').json({ hidden: !!userId && (await hiddenUsers()).has(userId) });
  });

  router.get('/media/:server/:mediaId', async (req, res) => {
    if (limited(req, res, mediaLimiter)) return;
    const mxc = `mxc://${req.params.server}/${req.params.mediaId}`;
    if (!isMxc(mxc) || !media.has(mxc)) return void res.status(404).end();
    try {
      const mx = await getServiceClient();
      const width = Number(req.query.width);
      const height = Number(req.query.height);
      const thumbnail = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 1600 && height <= 1600;
      const path = thumbnail
        ? `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(req.params.server)}/${encodeURIComponent(req.params.mediaId)}?width=${width}&height=${height}&method=scale&animated=true`
        : `/_matrix/client/v1/media/download/${encodeURIComponent(req.params.server)}/${encodeURIComponent(req.params.mediaId)}`;
      const upstream = await fetch(`${mx.baseUrl}${path}`, { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } });
      const type = upstream.headers.get('content-type');
      if (!upstream.ok || !upstream.body || !isServableMediaType(type)) return void res.status(404).end();
      res.set({
        'Content-Type': type!,
        'Cache-Control': 'public, max-age=86400, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cross-Origin-Resource-Policy': 'same-site',
      });
      const length = upstream.headers.get('content-length');
      if (length) res.set('Content-Length', length);
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (err) {
      console.error('Public media failed', err);
      res.status(502).end();
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
      media.allow(collectMxc(page));
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
