import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { applyPostEdits, editTargetOf, followSpaceFeeds } from '../feed';
import {
  dedupeSources,
  fetchFeedPage,
  fetchNewestPosts,
  GLOBAL_FEED_CONCURRENCY,
  listDirectory,
  listPeerDirectories,
  loadProfileSource,
  loadListedSpaceSources,
  loadPublicSpaceSources,
  loadUserProfileSource,
  mapWithConcurrency,
  MAX_FEEDS,
  mergePosts,
  ownProfileSource,
  postsFromEvents,
  privateJoinedSpaces,
  privateJoinedSpaceSources,
  type FeedSource,
  type GlobalPost,
} from '../globalFeed';
import { fetchPeers } from '../peers';
import { loadSnapshot, MAIN_FEED_SNAPSHOT, saveSnapshot, snapshotInMemory, updateFeed, type FeedSnapshot, type RoomRead } from '../feedSnapshot';
import { warmPostMedia } from '../mediaWarm';

export type GlobalFeed = {
  /** Every post from every readable source. Views narrow it with `filterPosts`. */
  posts: GlobalPost[];
  /** Posts that arrived after the timeline was shown, held back so nothing moves under the
   *  reader — the "N new posts" pill. `showNew` puts them in. Your own posts skip the wait. */
  pending: GlobalPost[];
  showNew: () => void;
  /** Every feed being read — profile sources carry who their owner follows (follower counts). */
  sources: FeedSource[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Listed Spaces — the only Spaces a repost may come from or go to. */
  publicSpaceIds: Set<string>;
  /** Public Spaces from the directory, for "Spaces to follow". */
  publicSpaces: { roomId: string; name: string }[];
  /** Whether the directory has answered — until then, which Spaces are public is unknown. */
  directoryLoaded: boolean;
  unreadableSpaces: number;
  /** The directory had more public profiles/Spaces than are read, so Everyone is a sample. */
  directoryTruncated: boolean;
  error?: string;
  loadMore: () => void;
  refresh: () => void;
  /** After posting into a feed room this feed didn't know about yet (a first post creates it). */
  addSource: (source: FeedSource) => void;
};

/** People and Spaces to read whatever the directory caps say: follows, or the profile being viewed. */
export type Pinned = { users: string[]; spaces: string[] };
const NOTHING_PINNED: Pinned = { users: [], spaces: [] };

/**
 * Where a view keeps the timeline it last showed (feedSnapshot.ts), and whose posts are its own: a
 * profile reads and keeps only that person's feeds (every feed is still listed, for follower
 * counts). A view with none of its own yet starts from the main feed's.
 */
export type SnapshotOptions = { key: string; keep?: (source: FeedSource) => boolean };

function narrowed(snapshot: FeedSnapshot, keep: SnapshotOptions['keep']): FeedSnapshot {
  return keep ? { ...snapshot, posts: snapshot.posts.filter((post) => keep(post.source)) } : snapshot;
}

function initialSnapshot(snapshot: SnapshotOptions | undefined): FeedSnapshot | undefined {
  if (!snapshot) return undefined;
  const own = snapshotInMemory(snapshot.key);
  if (own) return own;
  const main = snapshot.keep && snapshotInMemory(MAIN_FEED_SNAPSHOT);
  return main ? narrowed(main, snapshot.keep) : undefined;
}

/** How long the timeline waits to settle before it's kept again. */
const SNAPSHOT_SAVE_DELAY_MS = 1500;
/** Posts near the top whose pictures are fetched ahead of the reader (mediaWarm.ts). */
const WARM_POSTS = 20;
/** A kept list of feeds younger than this is used as it is: no directory or `/state` reads. */
const SOURCES_FRESH_MS = 15 * 60_000;
/** A kept timeline younger than this is brought up to date (each feed's newest posts) rather than
 *  read again (a page of each). Older, it's read again whole, which also catches deletions further
 *  back than the newest posts. */
const UPDATE_WITHIN_MS = 6 * 60 * 60_000;
/** A kept timeline younger than this isn't asked about at all: it was just read. */
const JUST_READ_MS = 30_000;

/** How often feeds this client isn't in are asked for new posts. */
const NEW_POSTS_CHECK_MS = 60_000;

/**
 * Everything the global feed, the Following timeline, and profiles read from — see
 * matrix/globalFeed.ts for what each source is and why Everyone is public-only.
 *
 * All sources are paged together (a timeline sorted across authors can't be paged one feed at
 * a time without misordering). Joined feed rooms update live; the rest are a snapshot, re-read
 * by `refresh`.
 *
 * `paused`: kept loaded but out of sight (the feed stays mounted behind a chat, MainPane.tsx), so
 * the periodic check for new posts waits, and runs as soon as it's back if one came due meanwhile.
 *
 * `snapshot`: the view's last timeline is shown at once, from memory or the device, and only
 * what's changed is read (feedSnapshot.ts): with a recent list of feeds, no directory or `/state`
 * reads; with a recent timeline, each feed's newest posts rather than a page of each. `refresh`
 * reads everything again.
 */
export function useGlobalFeed(
  enabled: boolean,
  pinnedInput: Pinned = NOTHING_PINNED,
  { paused = false, snapshot }: { paused?: boolean; snapshot?: SnapshotOptions } = {}
): GlobalFeed {
  const mx = useMatrixClient();
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const lastCheckRef = useRef(Date.now());
  const checkRef = useRef<() => Promise<void>>(async () => undefined);
  // A string key, so a new-but-equal array from the caller doesn't reload everything.
  const pinnedKey = JSON.stringify([[...pinnedInput.users].sort(), [...pinnedInput.spaces].sort()]);
  const pinned = useMemo(() => {
    const [users, spaces] = JSON.parse(pinnedKey) as [string[], string[]];
    return { users, spaces };
  }, [pinnedKey]);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const snapshotKey = snapshot?.key;
  const [initial] = useState(() => initialSnapshot(snapshot));
  const [posts, setPosts] = useState<GlobalPost[]>(() => initial?.posts ?? []);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [publicSpaces, setPublicSpaces] = useState<{ roomId: string; name: string }[]>(() => initial?.publicSpaces ?? []);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [unreadableSpaces, setUnreadableSpaces] = useState(0);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<GlobalPost[]>([]);
  const [sources, setSources] = useState<FeedSource[]>(() => initial?.sources ?? []);
  const tokensRef = useRef(new Map<string, string>());
  // Feeds read in this load (whether or not more remains), and when: what the snapshot keeps.
  const readRoomsRef = useRef(new Set<string>());
  const readAtRef = useRef(0);
  const sourcesAtRef = useRef(0);
  const sourcesRef = useRef(new Map<string, FeedSource>());
  // What's shown or waiting, for telling a new post from one already there.
  const knownIdsRef = useRef(new Set<string>());
  // When the feed started loading: only a post made after it is "new" (held for the pill).
  const loadedAtRef = useRef(Date.now());
  const busyRef = useRef(false);
  // Every post edit seen so far: an edit can arrive on a different page from its post.
  const editsRef = useRef<MatrixEvent[]>([]);
  const withEdits = useCallback((list: GlobalPost[]) => {
    applyPostEdits(
      list.map((post) => post.event),
      editsRef.current
    );
    return list;
  }, []);
  /**
   * Posts that turned up after the feed was shown: held back for the "N new posts" pill if they
   * were made since it loaded, put straight in (by date, where they belong) if they're older. A
   * room the app joins, or catches up on after the tab slept, arrives with its latest events, which
   * looked just like new posts: "8 new posts" that were already on screen, or older ones that
   * sorted far down, so pressing the pill seemed to do nothing.
   */
  const addArrivals = useCallback(
    (arrivals: GlobalPost[]) => {
      const fresh = arrivals.filter((post) => post.ts > loadedAtRef.current);
      const older = arrivals.filter((post) => post.ts <= loadedAtRef.current);
      if (older.length) setPosts((prev) => withEdits(mergePosts(prev, older)));
      if (fresh.length) setPending((prev) => withEdits(mergePosts(prev, fresh)));
    },
    [withEdits]
  );
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const initialLoadRef = useRef(false);
  // Bumped when an initial load finishes, so pins added during it get picked up after.
  const [initialLoadDone, setInitialLoadDone] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    initialLoadRef.current = true;
    loadedAtRef.current = Date.now();
    tokensRef.current = new Map();
    sourcesRef.current = new Map();
    readRoomsRef.current = new Set();
    readAtRef.current = 0;
    knownIdsRef.current = new Set();
    editsRef.current = [];
    setPending([]);
    busyRef.current = true;
    setLoading(true);
    setError(undefined);
    const keep = snapshotRef.current?.keep;
    // The refresh button reads everything again.
    const fresh = generation > 0;

    /** Every feed to read: this server's directory and each peer's, their Spaces' and profiles'
     *  state, whoever is followed, and the private Spaces you're in. */
    const gatherSources = async (): Promise<FeedSource[] | undefined> => {
      // This server's directory, and each federated instance's (docs/federation.md): a peer's
      // rooms read like this server's once the token server's bot has joined them, and one it
      // hasn't joined yet just doesn't load this time.
      const [ownDirectory, peerDirectory] = await Promise.all([
        listDirectory(mx),
        fetchPeers().then((peers) => listPeerDirectories(mx, peers)),
      ]);
      if (cancelled) return undefined;
      const directory = {
        ...ownDirectory,
        spaces: [...ownDirectory.spaces, ...peerDirectory.spaces],
        profiles: [...ownDirectory.profiles, ...peerDirectory.profiles],
      };
      setPublicSpaces(directory.spaces.map(({ roomId, name }) => ({ roomId, name })));
      setDirectoryLoaded(true);
      const publicIds = new Set(directory.spaces.map((space) => space.roomId));

      // A private Space's feed rooms are members-only (feed.ts), so reading them means joining
      // them — which a member of the Space may do, and the Space's own Posts page does too.
      await mapWithConcurrency(privateJoinedSpaces(mx, publicIds), GLOBAL_FEED_CONCURRENCY, (space) =>
        followSpaceFeeds(mx, space)
      );
      if (cancelled) return undefined;

      const [spaceResults, profileResults, own] = await Promise.all([
        mapWithConcurrency(directory.spaces, GLOBAL_FEED_CONCURRENCY, (space) => loadPublicSpaceSources(mx, space)),
        mapWithConcurrency(directory.profiles, GLOBAL_FEED_CONCURRENCY, (profile) => loadProfileSource(mx, profile.roomId)),
        ownProfileSource(mx),
      ]);
      if (cancelled) return undefined;
      // `null` = won't show its state to non-members; `undefined` = the request failed.
      // Only this server's: a peer's Space the bot hasn't joined yet isn't something to report.
      setUnreadableSpaces(spaceResults.slice(0, ownDirectory.spaces.length).filter((sources) => !sources).length);
      setDirectoryTruncated(directory.truncated);

      // People and Spaces asked for by name (followed, or the profile being viewed) that the
      // directory's capped pages didn't reach — read directly, so they're never missing.
      const profileOwners = new Set(profileResults.map((source) => source?.owner));
      const listedIds = new Set(directory.spaces.map((space) => space.roomId));
      const [pinnedProfiles, pinnedSpaces] = await Promise.all([
        mapWithConcurrency(
          pinnedRef.current.users.filter((userId) => !profileOwners.has(userId) && userId !== mx.getUserId()),
          GLOBAL_FEED_CONCURRENCY,
          (userId) => loadUserProfileSource(mx, userId)
        ),
        mapWithConcurrency(
          pinnedRef.current.spaces.filter((spaceId) => !listedIds.has(spaceId)),
          GLOBAL_FEED_CONCURRENCY,
          (spaceId) => loadListedSpaceSources(mx, spaceId)
        ),
      ]);
      if (cancelled) return undefined;
      const pinnedSpaceSources = pinnedSpaces.flatMap((list) => list ?? []);
      const pinnedPublic = pinnedSpaceSources.flatMap((source) =>
        source.origin.kind === 'space' ? [{ roomId: source.origin.spaceId, name: source.origin.spaceName }] : []
      );
      if (pinnedPublic.length) {
        setPublicSpaces((prev) => [...prev, ...pinnedPublic.filter((space, i, all) => all.findIndex((s) => s.roomId === space.roomId) === i)]);
      }
      const allPublicIds = new Set([...publicIds, ...pinnedPublic.map((space) => space.roomId)]);

      // Asked-for sources go first, so the MAX_FEEDS cut never drops them.
      return dedupeSources([
        ...(own ? [own] : []),
        ...pinnedProfiles.filter((source): source is FeedSource => !!source),
        ...pinnedSpaceSources,
        ...spaceResults.flatMap((list) => list ?? []),
        ...profileResults.filter((source): source is FeedSource => !!source),
        ...privateJoinedSpaceSources(mx, allPublicIds),
      ]).slice(0, MAX_FEEDS);
    };

    void (async () => {
      try {
        // What this view showed last: in memory, or (the app was just opened) on the device.
        let base: FeedSnapshot | undefined;
        if (snapshotKey && !fresh) {
          base = initialSnapshot(snapshotRef.current);
          if (!base) {
            const kept = await loadSnapshot(snapshotKey);
            if (cancelled) return;
            if (kept) {
              const shown = narrowed(kept, keep);
              base = shown;
              editsRef.current.push(...kept.edits);
              setPosts((prev) => (prev.length ? prev : shown.posts));
              setSources((prev) => (prev.length ? prev : shown.sources));
              setPublicSpaces((prev) => (prev.length ? prev : shown.publicSpaces));
            }
          }
        }
        const now = Date.now();

        let sources: FeedSource[];
        if (base && now - base.sourcesAt < SOURCES_FRESH_MS) {
          // The feeds as gathered a moment ago: none of the directory or state reads again.
          setPublicSpaces(base.publicSpaces);
          setDirectoryLoaded(true);
          setUnreadableSpaces(base.unreadable);
          setDirectoryTruncated(base.truncated);
          const publicIds = new Set(base.publicSpaces.map((space) => space.roomId));
          void mapWithConcurrency(privateJoinedSpaces(mx, publicIds), GLOBAL_FEED_CONCURRENCY, (space) => followSpaceFeeds(mx, space));
          sources = dedupeSources([...base.sources, ...privateJoinedSpaceSources(mx, publicIds)]).slice(0, MAX_FEEDS);
          sourcesAtRef.current = base.sourcesAt;
        } else {
          const gathered = await gatherSources();
          if (!gathered) return;
          sources = gathered;
          sourcesAtRef.current = Date.now();
        }
        sources.forEach((source) => sourcesRef.current.set(source.roomId, source));
        setSources([...sourcesRef.current.values()]);

        // Posts: only the view's own feeds (a profile's person's), each brought up to date from
        // what was kept when that's recent enough, otherwise read from the top.
        const update = base && now - base.at < UPDATE_WITHIN_MS ? base : undefined;
        const justRead = !!update && now - update.at < JUST_READ_MS;
        const keptByRoom = new Map<string, GlobalPost[]>();
        update?.posts.forEach((post) => keptByRoom.set(post.source.roomId, [...(keptByRoom.get(post.source.roomId) ?? []), post]));
        const toRead = keep ? sources.filter(keep) : sources;
        const reads = await mapWithConcurrency(toRead, GLOBAL_FEED_CONCURRENCY, (source) => {
          const read = update?.rooms[source.roomId];
          return updateFeed(mx, source, read ? (keptByRoom.get(source.roomId) ?? []) : undefined, read, justRead);
        });
        if (cancelled) return;
        let merged: GlobalPost[] = [];
        reads.forEach((read, index) => {
          if (!read) return;
          const { roomId } = toRead[index];
          readRoomsRef.current.add(roomId);
          merged = mergePosts(merged, read.posts);
          editsRef.current.push(...read.edits);
          if (read.token) tokensRef.current.set(roomId, read.token);
        });
        merged.forEach((post) => knownIdsRef.current.add(post.eventId));
        readAtRef.current = justRead && update ? update.at : Date.now();
        setPosts(withEdits(merged));
        // The pictures the reader is about to scroll to, fetched ahead (low priority).
        void warmPostMedia(mx, merged.slice(0, WARM_POSTS));
        setHasMore(tokensRef.current.size > 0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Couldn’t load posts');
      } finally {
        busyRef.current = false;
        if (!cancelled) {
          setLoading(false);
          initialLoadRef.current = false;
          setInitialLoadDone((n) => n + 1);
        }
      }
    })();

    const onTimeline = (event: MatrixEvent, room: Room | undefined, toStartOfTimeline?: boolean, removed?: boolean, data?: { liveEvent?: boolean }) => {
      const source = room && sourcesRef.current.get(room.roomId);
      if (!source) return;
      // Only what just arrived. History fetched further back (the room views, the background fill
      // in historyPrefetch.ts) fires the same event, and old posts counted as "N new posts"; shown,
      // they sorted far down the feed, so pressing the pill seemed to do nothing. The feed reads
      // older posts through its own pages.
      if (toStartOfTimeline || removed || data?.liveEvent === false) return;
      if (editTargetOf(event)) {
        editsRef.current.push(event);
        setPosts((prev) => (applyPostEdits(prev.map((post) => post.event), editsRef.current) ? [...prev] : prev));
        return;
      }
      const incoming = postsFromEvents(source, [event]).filter((post) => !knownIdsRef.current.has(post.eventId));
      if (!incoming.length) return;
      incoming.forEach((post) => knownIdsRef.current.add(post.eventId));
      // Your own post goes straight in — you just made it and expect to see it.
      if (event.getSender() === mx.getUserId()) setPosts((prev) => withEdits(mergePosts(prev, incoming)));
      else addArrivals(incoming);
    };
    const onRedaction = (redaction: MatrixEvent) => {
      const redacted = redaction.event.redacts ?? redaction.getContent().redacts;
      if (!redacted) return;
      setPosts((prev) => prev.filter((post) => post.eventId !== redacted));
      setPending((prev) => prev.filter((post) => post.eventId !== redacted));
    };
    mx.on(RoomEvent.Timeline, onTimeline);
    mx.on(RoomEvent.Redaction, onRedaction);
    return () => {
      cancelled = true;
      mx.removeListener(RoomEvent.Timeline, onTimeline);
      mx.removeListener(RoomEvent.Redaction, onRedaction);
    };
  }, [mx, enabled, generation, withEdits, addArrivals, snapshotKey]);

  // What's shown is kept for next time, once it has settled.
  useEffect(() => {
    if (!snapshotKey || loading || posts.length === 0 || !readAtRef.current) return undefined;
    const timer = setTimeout(() => {
      const keep = snapshotRef.current?.keep;
      const rooms: Record<string, RoomRead> = {};
      readRoomsRef.current.forEach((roomId) => {
        const token = tokensRef.current.get(roomId);
        rooms[roomId] = token ? { token } : {};
      });
      saveSnapshot(
        snapshotKey,
        {
          at: readAtRef.current,
          sourcesAt: sourcesAtRef.current,
          sources,
          posts: keep ? posts.filter((post) => keep(post.source)) : posts,
          rooms,
          publicSpaces,
          truncated: directoryTruncated,
          unreadable: unreadableSpaces,
        },
        editsRef.current
      );
    }, SNAPSHOT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [snapshotKey, loading, posts, sources, publicSpaces, directoryTruncated, unreadableSpaces]);

  const loadMore = useCallback(() => {
    if (busyRef.current || tokensRef.current.size === 0) return;
    busyRef.current = true;
    setLoadingMore(true);
    const pending = [...tokensRef.current.entries()];
    void mapWithConcurrency(pending, GLOBAL_FEED_CONCURRENCY, ([roomId, token]) => {
      const source = sourcesRef.current.get(roomId);
      return source ? fetchFeedPage(mx, source, token) : Promise.resolve(undefined);
    }).then((pages) => {
      let incoming: GlobalPost[] = [];
      pages.forEach((page, index) => {
        const [roomId] = pending[index];
        if (!page) return; // keeps its token, so the next "load older" retries it
        page.posts.forEach((post) => knownIdsRef.current.add(post.eventId));
        incoming = incoming.concat(page.posts);
        editsRef.current.push(...page.edits);
        if (page.nextToken) tokensRef.current.set(roomId, page.nextToken);
        else tokensRef.current.delete(roomId);
      });
      setPosts((prev) => withEdits(mergePosts(prev, incoming)));
      setHasMore(tokensRef.current.size > 0);
      setLoadingMore(false);
      busyRef.current = false;
    });
  }, [mx, withEdits]);

  const refresh = useCallback(() => setGeneration((n) => n + 1), []);

  const showNew = useCallback(() => {
    setPending((waiting) => {
      if (waiting.length) setPosts((prev) => withEdits(mergePosts(prev, waiting)));
      return [];
    });
  }, [withEdits]);

  const addSource = useCallback(
    (source: FeedSource) => {
      if (sourcesRef.current.has(source.roomId)) return;
      sourcesRef.current.set(source.roomId, source);
      setSources([...sourcesRef.current.values()]);
      void fetchFeedPage(mx, source)
        .then((page) => {
          readRoomsRef.current.add(source.roomId);
          if (page.nextToken) tokensRef.current.set(source.roomId, page.nextToken);
          editsRef.current.push(...page.edits);
          // Arriving from something you did (your first post there, or following someone): shown
          // at once rather than waiting behind the pill.
          page.posts.forEach((post) => knownIdsRef.current.add(post.eventId));
          setPosts((prev) => withEdits(mergePosts(prev, page.posts)));
        })
        .catch(() => undefined);
    },
    [mx, withEdits]
  );

  // Feeds this client is in update live (onTimeline, above). The rest are read over plain
  // /messages, so they're asked for their newest posts now and then — only while the window is
  // actually being looked at, and never over a load already in progress.
  useEffect(() => {
    if (!enabled) return undefined;
    let checking = false;
    lastCheckRef.current = Date.now();
    const check = async () => {
      if (checking || busyRef.current || pausedRef.current || document.visibilityState !== 'visible') return;
      checking = true;
      lastCheckRef.current = Date.now();
      try {
        const unjoined = [...sourcesRef.current.values()].filter(
          (source) => mx.getRoom(source.roomId)?.getMyMembership() !== 'join'
        );
        const pages = await mapWithConcurrency(unjoined, GLOBAL_FEED_CONCURRENCY, (source) => fetchNewestPosts(mx, source));
        const fresh: GlobalPost[] = [];
        const removed = new Set<string>();
        let edited = false;
        pages.forEach((page) => {
          if (!page) return;
          page.removed.forEach((id) => removed.add(id));
          if (page.edits.length) {
            editsRef.current.push(...page.edits);
            edited = true;
          }
          page.posts.forEach((post) => {
            if (knownIdsRef.current.has(post.eventId)) return;
            knownIdsRef.current.add(post.eventId);
            fresh.push(post);
          });
        });
        if (removed.size) {
          setPosts((prev) => (prev.some((post) => removed.has(post.eventId)) ? prev.filter((post) => !removed.has(post.eventId)) : prev));
          setPending((prev) => prev.filter((post) => !removed.has(post.eventId)));
        }
        if (fresh.length) addArrivals(fresh);
        if (edited) setPosts((prev) => (applyPostEdits(prev.map((post) => post.event), editsRef.current) ? [...prev] : prev));
      } finally {
        checking = false;
      }
    };
    checkRef.current = check;
    const timer = setInterval(() => void check(), NEW_POSTS_CHECK_MS);
    return () => clearInterval(timer);
  }, [mx, enabled, generation, withEdits, addArrivals]);

  // Back in sight after a while away: catch up now rather than at the next tick.
  useEffect(() => {
    if (enabled && !paused && Date.now() - lastCheckRef.current >= NEW_POSTS_CHECK_MS) void checkRef.current();
  }, [enabled, paused]);

  // Following someone new mid-session adds just their feeds, rather than reloading the timeline.
  // During the initial load there's nothing to add to yet: that load reads pinnedRef itself, and
  // re-runs this when it's done in case the pins changed meanwhile.
  useEffect(() => {
    if (!enabled || initialLoadRef.current) return;
    const owners = new Set([...sourcesRef.current.values()].map((source) => source.owner));
    const spaces = new Set(
      [...sourcesRef.current.values()].flatMap((source) => (source.origin.kind === 'space' ? [source.origin.spaceId] : []))
    );
    pinned.users
      .filter((userId) => !owners.has(userId) && userId !== mx.getUserId())
      .forEach((userId) => {
        void loadUserProfileSource(mx, userId)
          .then((source) => source && addSource(source))
          .catch(() => undefined);
      });
    pinned.spaces
      .filter((spaceId) => !spaces.has(spaceId))
      .forEach((spaceId) => {
        void loadListedSpaceSources(mx, spaceId)
          .then((list) => list?.forEach(addSource))
          .catch(() => undefined);
      });
  }, [mx, enabled, pinned, addSource, initialLoadDone]);

  const publicSpaceIds = new Set(publicSpaces.map((space) => space.roomId));

  // Never counted while it's already on screen: a post can reach both, from sync (before the
  // feed's first pages are in, when nothing is known yet) and from those pages.
  const shownIds = new Set(posts.map((post) => post.eventId));
  const waiting = pending.filter((post) => !shownIds.has(post.eventId));

  return {
    posts,
    pending: waiting,
    showNew,
    sources,
    loading,
    loadingMore,
    hasMore,
    publicSpaceIds,
    publicSpaces,
    directoryLoaded,
    directoryTruncated,
    unreadableSpaces,
    error,
    loadMore,
    refresh,
    addSource,
  };
}
