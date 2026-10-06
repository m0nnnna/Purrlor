import { MatrixEvent, type IEvent, type MatrixClient } from 'matrix-js-sdk';
import { applyPostEdits, editTargetOf } from './feed';
import { getCached, putCached } from './deviceCache';
import { fetchFeedPage, fetchNewestPosts, MAX_FEEDS, mergePosts, NEWEST_CHECK_SIZE, type FeedSource, type GlobalPost } from './globalFeed';

/**
 * The last timeline a feed view showed, and how far each of its feeds had been read, so opening it
 * again (another tab, a profile visited before, the app opened again) shows those posts at once and
 * then asks only for what's new (useGlobalFeed): the feeds' newest posts rather than a page of
 * each, and the directory and every feed's `/state` not at all while the list of feeds is recent.
 * Those reads are slow where it matters most: a peer's (docs/federation.md) cross federation.
 *
 * Kept in memory for the session, and on the device (deviceCache.ts) for a week, deleted with the
 * rest on signing out (which reloads the page, so the memory goes too). Only what was readable as
 * it arrived: an encrypted post is left out, so a private Space's decrypted text is never written
 * to disk by this.
 */

/** The feed's own (GlobalFeedView): a view with none yet starts from its posts (useGlobalFeed). */
export const MAIN_FEED_SNAPSHOT = 'feed';
/** Posts written to the device per view. */
export const SNAPSHOT_POSTS = 300;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * How far a feed has been read. `token`: where its older posts carry on. Neither: read to its
 * start. `cut`: some of its posts weren't kept (past SNAPSHOT_POSTS, or encrypted), so what's kept
 * no longer reaches its token: it's read again from the top.
 */
export type RoomRead = { token?: string; cut?: true };

export type FeedSnapshot = {
  /** When its posts were last read. */
  at: number;
  /** When its feeds were last gathered (the directory, each Space's and profile's state). */
  sourcesAt: number;
  sources: FeedSource[];
  posts: GlobalPost[];
  /** Every feed read, by room. */
  rooms: Record<string, RoomRead>;
  publicSpaces: { roomId: string; name: string }[];
  truncated: boolean;
  unreadable: number;
};

type StoredSnapshot = Omit<FeedSnapshot, 'posts'> & {
  posts: { raw: Partial<IEvent>; roomId: string }[];
  edits: Partial<IEvent>[];
};

const inMemory = new Map<string, FeedSnapshot>();

/** What's written: the newest posts, every feed and how far it was read, the edits that apply. Pure. */
export function toStoredSnapshot(snapshot: FeedSnapshot, edits: MatrixEvent[]): StoredSnapshot {
  const cut = new Set<string>();
  const posts: GlobalPost[] = [];
  snapshot.posts.forEach((post) => {
    // Sent and readable as they are: no local echo, nothing that arrived encrypted.
    if (!post.eventId.startsWith('$')) return;
    if (post.event.isEncrypted() || posts.length >= SNAPSHOT_POSTS) cut.add(post.source.roomId);
    else posts.push(post);
  });
  const ids = new Set(posts.map((post) => post.eventId));
  const rooms: Record<string, RoomRead> = {};
  Object.entries(snapshot.rooms).forEach(([roomId, read]) => {
    rooms[roomId] = cut.has(roomId) ? { cut: true } : read;
  });
  return {
    ...snapshot,
    sources: snapshot.sources.slice(0, MAX_FEEDS),
    rooms,
    posts: posts.map((post) => ({ raw: post.event.event, roomId: post.source.roomId })),
    edits: edits.filter((edit) => ids.has(editTargetOf(edit) ?? '') && !edit.isEncrypted()).map((edit) => edit.event),
  };
}

/** The snapshot back, its edits applied, as posts ready for the feed. Pure. */
export function fromStoredSnapshot(stored: StoredSnapshot): FeedSnapshot & { edits: MatrixEvent[] } {
  const byRoom = new Map(stored.sources.map((source) => [source.roomId, source]));
  const posts = stored.posts.flatMap(({ raw, roomId }) => {
    const source = byRoom.get(roomId);
    if (!source || typeof raw.event_id !== 'string') return [];
    const event = new MatrixEvent(raw);
    return [{ eventId: raw.event_id, ts: event.getTs(), event, source }];
  });
  const edits = stored.edits.map((raw) => new MatrixEvent(raw));
  applyPostEdits(
    posts.map((post) => post.event),
    edits
  );
  return { ...stored, posts, edits };
}

/** This session's snapshot for a view, for its first paint. */
export function snapshotInMemory(key: string): FeedSnapshot | undefined {
  return inMemory.get(key);
}

/** The device's snapshot for a view, from an earlier session. */
export async function loadSnapshot(key: string): Promise<(FeedSnapshot & { edits: MatrixEvent[] }) | undefined> {
  const stored = await getCached<StoredSnapshot>(`feed-snapshot:${key}`);
  return stored?.rooms ? fromStoredSnapshot(stored) : undefined;
}

export function saveSnapshot(key: string, snapshot: FeedSnapshot, edits: MatrixEvent[]): void {
  inMemory.set(key, snapshot);
  void putCached(`feed-snapshot:${key}`, toStoredSnapshot(snapshot, edits), SNAPSHOT_TTL_MS);
}

export type FeedRead = { posts: GlobalPost[]; edits: MatrixEvent[]; token?: string };

/**
 * One feed's posts for this load: what was kept, brought up to date by its newest posts, when the
 * kept copy reaches that far; otherwise a page from the top. A kept copy that can't be brought up
 * to date (the request failed) is shown as it was.
 */
export async function updateFeed(
  mx: MatrixClient,
  source: FeedSource,
  kept: GlobalPost[] | undefined,
  read: RoomRead | undefined,
  skip: boolean
): Promise<FeedRead> {
  if (kept && read && !read.cut) {
    const known = kept.map((post) => ({ ...post, source }));
    if (skip) return { posts: known, edits: [], token: read.token };
    try {
      const newest = await fetchNewestPosts(mx, source);
      const knownIds = new Set(known.map((post) => post.eventId));
      // As many new posts as were asked for and none of them known: there may be more between
      // them and what was kept, so read it from the top instead.
      const gap = newest.posts.length >= NEWEST_CHECK_SIZE && !newest.posts.some((post) => knownIds.has(post.eventId));
      if (!gap) {
        const removed = new Set(newest.removed);
        return {
          posts: mergePosts(
            known.filter((post) => !removed.has(post.eventId)),
            newest.posts
          ),
          edits: newest.edits,
          token: read.token,
        };
      }
    } catch {
      return { posts: known, edits: [], token: read.token };
    }
  }
  const page = await fetchFeedPage(mx, source);
  return { posts: page.posts, edits: page.edits, token: page.nextToken };
}
