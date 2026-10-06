import { MatrixEvent, type IEvent } from 'matrix-js-sdk';
import { editTargetOf } from './feed';
import { getCached, putCached } from './deviceCache';
import type { FeedSource, GlobalPost } from './globalFeed';

/**
 * The last timeline a feed view showed, kept so opening it again (another tab, a profile visited
 * before, the app opened again) shows those posts at once while the fresh read runs behind them.
 * That read is slow where it matters most: each Space and profile it follows is a `/state` and a
 * `/messages`, and a peer's (docs/federation.md) go through federation's directories first.
 *
 * Kept in memory for the session, and on the device (deviceCache.ts) for a week, deleted with the
 * rest on signing out (which reloads the page, so the memory goes too). Only what was readable as
 * it arrived: an encrypted post is left out, so a private Space's decrypted text is never written
 * to disk by this. The fresh read replaces the snapshot whole, so a post deleted meanwhile is only
 * shown until it lands.
 */

/** The feed's own (GlobalFeedView): a view with none yet starts from its posts (useGlobalFeed). */
export const MAIN_FEED_SNAPSHOT = 'feed';
/** Posts kept per view: about three screens. */
export const SNAPSHOT_POSTS = 60;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000;

export type FeedSnapshot = {
  sources: FeedSource[];
  posts: GlobalPost[];
  publicSpaces: { roomId: string; name: string }[];
};

type StoredSnapshot = {
  sources: FeedSource[];
  posts: { raw: Partial<IEvent>; roomId: string }[];
  edits: Partial<IEvent>[];
  publicSpaces: { roomId: string; name: string }[];
};

const inMemory = new Map<string, FeedSnapshot>();

/** What's written: the newest posts, their sources, and the edits that apply to them. Pure. */
export function toStoredSnapshot(snapshot: FeedSnapshot, edits: MatrixEvent[]): StoredSnapshot {
  const posts = snapshot.posts
    // Sent and readable as they are: no local echo, nothing that arrived encrypted.
    .filter((post) => post.eventId.startsWith('$') && !post.event.isEncrypted())
    .slice(0, SNAPSHOT_POSTS);
  const ids = new Set(posts.map((post) => post.eventId));
  const roomIds = new Set(posts.map((post) => post.source.roomId));
  return {
    sources: snapshot.sources.filter((source) => roomIds.has(source.roomId)),
    posts: posts.map((post) => ({ raw: post.event.event, roomId: post.source.roomId })),
    edits: edits.filter((edit) => ids.has(editTargetOf(edit) ?? '') && !edit.isEncrypted()).map((edit) => edit.event),
    publicSpaces: snapshot.publicSpaces,
  };
}

/** The snapshot back, as posts and edits ready for the feed. Pure. */
export function fromStoredSnapshot(stored: StoredSnapshot): FeedSnapshot & { edits: MatrixEvent[] } {
  const byRoom = new Map(stored.sources.map((source) => [source.roomId, source]));
  const posts = stored.posts.flatMap(({ raw, roomId }) => {
    const source = byRoom.get(roomId);
    if (!source || typeof raw.event_id !== 'string') return [];
    const event = new MatrixEvent(raw);
    return [{ eventId: raw.event_id, ts: event.getTs(), event, source }];
  });
  return {
    sources: stored.sources,
    posts,
    publicSpaces: stored.publicSpaces,
    edits: stored.edits.map((raw) => new MatrixEvent(raw)),
  };
}

/** This session's snapshot for a view, for its first paint. */
export function snapshotInMemory(key: string): FeedSnapshot | undefined {
  return inMemory.get(key);
}

/** The device's snapshot for a view, from an earlier session. */
export async function loadSnapshot(key: string): Promise<(FeedSnapshot & { edits: MatrixEvent[] }) | undefined> {
  const stored = await getCached<StoredSnapshot>(`feed-snapshot:${key}`);
  return stored ? fromStoredSnapshot(stored) : undefined;
}

export function saveSnapshot(key: string, snapshot: FeedSnapshot, edits: MatrixEvent[]): void {
  const stored = toStoredSnapshot(snapshot, edits);
  inMemory.set(key, { ...snapshot, posts: snapshot.posts.slice(0, SNAPSHOT_POSTS * 2) });
  void putCached(`feed-snapshot:${key}`, stored, SNAPSHOT_TTL_MS);
}
