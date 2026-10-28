import { Router, type Request, type Response } from 'express';
import { clientIp } from './clientIp.js';
import { getServiceClient } from './membership.js';
import { localUserId, ownerStillThere, readProfileOwner, readPublicWeb, serverNameOf, splitMxc, type AdminLists, type RawEvent } from './publicWeb.js';
import { copyFromHomeserver, effectiveLists, getFeed, onFeedRefresh, peerServers, resolveUser, sendCopy, type FeedCache } from './publicWebRoutes.js';
import {
  catalogueVideo,
  cataloguePage,
  deletedVideoIds,
  isVideoId,
  MAX_VIEW_IDS,
  parseCatalogueQuery,
  parseViewKey,
  playToken,
  readPlayToken,
  VIDEO_TYPES,
  videosFromState,
  viewKey,
  type CatalogueVideo,
  type LivePointer,
  type Video,
  type ViewCounter,
  type WatchSettings,
} from './watch.js';
import { RateLimiter } from './webhooks.js';

/**
 * WATCH over HTTP (docs/watch.md, "API"), mounted at `/api/public/watch`. The rules are in watch.ts;
 * the profile rooms come from the public web's feed (publicWebRoutes.ts), and video files go out
 * through its media cache, so they can be seeked.
 *
 *   POST /catalogue        this server's people: every video, who's live, who has a story
 *   POST /play             a play address for one of this server's videos, counting the view
 *   GET  /file/:token      the file, with ranges
 *   GET  /views?ids=       view counts for this server's videos (a peer's catalogue asks)
 *   GET  /limits           the upload limits
 *   GET  /:owner/:id       a public video, for the public web's video page
 */

export type WatchDeps = {
  settings: WatchSettings;
  views: ViewCounter;
  /** The key play tokens are signed with (watch.ts, loadWatchKey). */
  key: Promise<Buffer>;
  /** Who a Matrix OpenID token belongs to (throws if it doesn't check out). */
  caller(openIdToken: unknown): Promise<string>;
  serverName(): Promise<string>;
  /** Whether one of this server's own streams is live and `owner`'s, so a stale pointer isn't listed. */
  streamLive(owner: string, streamId: string): boolean;
};

const RATE_SCALE = Number(process.env.PUBLIC_WEB_RATE_SCALE) >= 1 ? Number(process.env.PUBLIC_WEB_RATE_SCALE) : 1;
const readLimiter = new RateLimiter(60 * RATE_SCALE, 120 * RATE_SCALE);
const playLimiter = new RateLimiter(30 * RATE_SCALE, 60 * RATE_SCALE);
// A player seeking asks for many ranges.
const fileLimiter = new RateLimiter(200 * RATE_SCALE, 600 * RATE_SCALE);

/** A room read again for a video newer than the feed (just uploaded or edited) is reused this long. */
const FRESH_STATE_MS = 15_000;

/** A play address is used from the viewer's own server's app, so other sites may load it. */
const FILE_HEADERS = { 'Cache-Control': 'private, max-age=600', 'Cross-Origin-Resource-Policy': 'cross-origin' };

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function limited(req: Request, res: Response, limiter: RateLimiter): boolean {
  if (limiter.take(clientIp(req))) return false;
  res.status(429).json({ error: 'Too many requests; slow down', code: 'rate_limited' });
  return true;
}

function fail(res: Response, err: unknown, what: string): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof Refusal) return void res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`Watch: ${what} failed`, err);
  res.status(503).json({ error: 'Not available right now', code: 'unavailable' });
}

const notFound = () => new Refusal(404, 'not_found', 'No such video');

type Found = { roomId: string; state: RawEvent[]; video: Video };

export class Watch {
  private fresh = new Map<string, { at: number; state: Promise<RawEvent[]> }>();

  constructor(private readonly deps: WatchDeps) {
    // Deleting a video drops its count: each new snapshot names this server's deleted videos.
    onFeedRefresh((feed) => void this.dropDeleted(feed));
  }

  private async dropDeleted(feed: FeedCache): Promise<void> {
    const server = await this.deps.serverName().catch(() => undefined);
    if (!server) return;
    for (const room of feed.byOwner.values()) {
      if (serverNameOf(room.owner) === server) this.deps.views.drop(room.owner, deletedVideoIds(room.state, room.owner));
    }
  }

  private async who(openIdToken: unknown): Promise<string> {
    try {
      return await this.deps.caller(openIdToken);
    } catch {
      throw new Refusal(401, 'auth_failed', 'Authentication failed');
    }
  }

  /** A room's state read just now (or in the last few seconds), for a video the snapshot doesn't have yet. */
  private freshState(roomId: string): Promise<RawEvent[]> {
    const now = Date.now();
    const cached = this.fresh.get(roomId);
    if (cached && now - cached.at < FRESH_STATE_MS) return cached.state;
    for (const [id, entry] of this.fresh) if (now - entry.at >= FRESH_STATE_MS) this.fresh.delete(id);
    const state = getServiceClient().then((mx) => mx.roomState(roomId) as unknown as Promise<RawEvent[]>);
    this.fresh.set(roomId, { at: now, state });
    state.catch(() => this.fresh.delete(roomId));
    return state;
  }

  /**
   * One of `owner`'s videos as it is now: from the snapshot, or, when the snapshot doesn't have it
   * (or has another file for it than `url`), from their room read again.
   */
  private async findVideo(feed: FeedCache, owner: string, id: string, url?: string): Promise<Found | undefined> {
    const room = feed.byOwner.get(owner);
    if (!room) return undefined;
    const known = room.videos.find((video) => video.id === id);
    if (known && (url === undefined || known.url === url)) return { roomId: room.roomId, state: room.state, video: known };
    const state = await this.freshState(room.roomId);
    if (readProfileOwner(state) !== owner || !ownerStillThere(state, owner)) return undefined;
    const video = videosFromState(state, owner, this.deps.settings.maxVideos).find((v) => v.id === id);
    return video ? { roomId: room.roomId, state, video } : undefined;
  }

  private viewsOf(feed: FeedCache, server: string, owner: string, id: string): number | undefined {
    return serverNameOf(owner) === server ? this.deps.views.views(owner, id) : feed.peerViews.get(viewKey(owner, id));
  }

  // --- Routes ----------------------------------------------------------------------------------

  async catalogue(body: Record<string, unknown>) {
    if (!body.openid_token) throw new Refusal(401, 'auth_required', 'openid_token is required');
    const userId = await this.who(body.openid_token);
    const server = await this.deps.serverName();
    if (serverNameOf(userId) !== server) throw new Refusal(403, 'not_local', 'Only people on this server can read its catalogue');
    const feed = await getFeed();
    const lists = await effectiveLists(feed);
    return cataloguePage(
      {
        rooms: feed.byOwner.values(),
        excluded: (owner) => lists.hidden.has(owner) || lists.publicOff.has(owner),
        blocked: (url) => lists.blockedMedia.has(url),
        views: (owner, id) => this.viewsOf(feed, server, owner, id),
        liveOk: (owner: string, pointer: LivePointer) => serverNameOf(owner) !== server || this.deps.streamLive(owner, pointer.stream_id),
        maxVideos: this.deps.settings.maxVideos,
      },
      parseCatalogueQuery(body)
    );
  }

  async play(body: Record<string, unknown>, ip: string) {
    const server = await this.deps.serverName();
    const owner = typeof body.owner === 'string' ? localUserId(body.owner, server) : undefined;
    if (!owner || !isVideoId(body.video_id)) throw notFound();
    // A token from anywhere is checked; a private video then needs a caller from here or a peer.
    const caller = body.openid_token ? await this.who(body.openid_token) : undefined;
    const signedIn = !!caller && (serverNameOf(caller) === server || (await peerServers()).has(serverNameOf(caller)));
    const feed = await getFeed();
    const lists = await effectiveLists(feed);
    if (lists.hidden.has(owner)) throw new Refusal(403, 'hidden', 'This channel isn’t available');
    const found = await this.findVideo(feed, owner, body.video_id);
    if (!found || lists.blockedMedia.has(found.video.url)) throw notFound();
    if (!signedIn && (found.video.visibility !== 'public' || !readPublicWeb(found.state) || lists.publicOff.has(owner))) throw notFound();

    const views = this.deps.views.count(owner, found.video.id, caller ?? `ip:${ip}`);
    const expires_at = Date.now() + this.deps.settings.playTtlS * 1000;
    const token = playToken(await this.deps.key, { owner, id: found.video.id, url: found.video.url, expires_at });
    // Start the copy now, so the file is (nearly) there when the player asks for it.
    void copyFromHomeserver(found.video.url, found.video.mimetype, this.deps.settings.maxBytes).catch((err: unknown) =>
      console.warn(`Watch: ${found.video.url} not copied ahead: ${(err as Error).message}`)
    );
    return { url: `/api/public/watch/file/${token}`, expires_at, views };
  }

  /** The file a play token names, if it may still be served. */
  async file(token: string) {
    const grant = readPlayToken(await this.deps.key, token, Date.now());
    if (grant === 'expired') throw new Refusal(410, 'expired', 'This play address has run out; press play again');
    if (!grant || serverNameOf(grant.owner) !== (await this.deps.serverName())) throw notFound();
    const feed = await getFeed();
    const lists = await effectiveLists(feed);
    const found = await this.findVideo(feed, grant.owner, grant.id, grant.url);
    // Deleted, or another file since: the address was for the old one.
    if (!found || found.video.url !== grant.url || lists.hidden.has(grant.owner) || lists.blockedMedia.has(grant.url)) throw notFound();
    const copy = await copyFromHomeserver(grant.url, found.video.mimetype, this.deps.settings.maxBytes);
    if (!copy) throw notFound();
    return copy;
  }

  async viewCounts(raw: unknown): Promise<Record<string, number>> {
    const server = await this.deps.serverName();
    const feed = await getFeed();
    const lists = await effectiveLists(feed);
    const out: Record<string, number> = {};
    const keys = typeof raw === 'string' ? raw.split(',').slice(0, MAX_VIEW_IDS) : [];
    for (const key of keys) {
      const parsed = parseViewKey(key);
      if (!parsed || serverNameOf(parsed.owner) !== server || lists.hidden.has(parsed.owner)) continue;
      if (feed.byOwner.get(parsed.owner)?.videos.some((video) => video.id === parsed.id)) out[key] = this.deps.views.views(parsed.owner, parsed.id);
    }
    return out;
  }

  limits() {
    return { max_bytes: this.deps.settings.maxBytes, max_videos: this.deps.settings.maxVideos, types: VIDEO_TYPES };
  }

  /** A public video, for the public web's page: only while its owner's page is public. */
  async publicVideo(rawOwner: string, id: string): Promise<CatalogueVideo | undefined> {
    const owner = await resolveUser(rawOwner);
    if (!owner || !isVideoId(id)) return undefined;
    const feed = await getFeed();
    const lists: AdminLists = await effectiveLists(feed);
    const room = feed.byOwner.get(owner);
    if (!room || lists.hidden.has(owner) || lists.publicOff.has(owner) || !feed.publicPages.has(owner)) return undefined;
    const video = room.videos.slice(0, this.deps.settings.maxVideos).find((v) => v.id === id);
    if (!video || video.visibility !== 'public' || lists.blockedMedia.has(video.url)) return undefined;
    const thumb = splitMxc(video.thumbnail)!;
    const entry = catalogueVideo(video, owner, room.roomId, this.viewsOf(feed, await this.deps.serverName(), owner, id));
    return { ...entry, thumbnail: `/api/public/media/${thumb.server}/${thumb.mediaId}` };
  }
}

export function watchRouter(watch: Watch): Router {
  const router = Router();
  const body = (req: Request) => (typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

  router.post('/catalogue', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      res.set('Cache-Control', 'no-store').json(await watch.catalogue(body(req)));
    } catch (err) {
      fail(res, err, 'the catalogue');
    }
  });

  router.post('/play', async (req, res) => {
    if (limited(req, res, playLimiter)) return;
    try {
      res.set('Cache-Control', 'no-store').json(await watch.play(body(req), clientIp(req)));
    } catch (err) {
      fail(res, err, 'playing');
    }
  });

  router.get('/file/:token', async (req, res) => {
    if (limited(req, res, fileLimiter)) return;
    try {
      await sendCopy(req, res, await watch.file(req.params.token), FILE_HEADERS);
    } catch (err) {
      fail(res, err, 'a video file');
    }
  });

  router.get('/views', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      res.set('Cache-Control', 'public, max-age=30').json({ views: await watch.viewCounts(req.query.ids) });
    } catch (err) {
      fail(res, err, 'view counts');
    }
  });

  router.get('/limits', (req, res) => {
    if (limited(req, res, readLimiter)) return;
    res.set('Cache-Control', 'public, max-age=300').json(watch.limits());
  });

  router.get('/:owner/:id', async (req, res) => {
    if (limited(req, res, readLimiter)) return;
    try {
      const video = await watch.publicVideo(req.params.owner, req.params.id);
      if (!video) return void res.status(404).json({ error: 'Sign in to see this video', code: 'not_found' });
      res.set('Cache-Control', 'public, max-age=60').json(video);
    } catch (err) {
      fail(res, err, 'a public video');
    }
  });

  return router;
}
