import { useCallback, useEffect, useRef, useState } from 'react';
import { EventType, RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import {
  deleteComment,
  fetchCommentLikes,
  fetchComments,
  fetchLikes,
  fetchOlderComments,
  fetchReposts,
  likeComment,
  likePost,
  mergeNewestPage,
  sendComment,
  summarizeCommentStats,
  threadFor,
  unlikePost,
  type CommentStats,
  type MyRepost,
  type OlderCursor,
  type PostComment,
  type ReplyTarget,
} from '../postInteractions';
import type { PostContent } from '../feed';
import { getCached, putCached } from '../deviceCache';

/** Every card on a page asks at once; this keeps it to a few requests in flight, the same budget
 *  the global feed uses for its own reads. */
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const queue: (() => void)[] = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          queue.shift()?.();
        });
    };
    if (inFlight < MAX_IN_FLIGHT) run();
    else queue.push(run);
  });
}

type State = {
  likeCount: number;
  likesTruncated: boolean;
  likers: string[];
  myLikeId?: string;
  repostCount: number;
  repostsTruncated: boolean;
  myRepost?: MyRepost;
  /** Loaded so far, oldest first — the newest page, plus any older pages asked for. */
  comments: PostComment[];
  /** Set while older comments exist on the server that haven't been loaded. */
  older?: OlderCursor;
  /** Each comment's likes and reposts, by comment ID; a comment with neither isn't listed. */
  commentStats: Record<string, CommentStats>;
};

/**
 * What each post's likes and comments were when last read, so a card drawn again (the feed opened
 * again, scrolled back to, the app opened again) shows them on its first paint instead of zeros
 * that jump a moment later. Read again behind that only once they're a few minutes old: a feed
 * room you're in updates them live anyway, and one you aren't in is a snapshot like its posts.
 * In memory for the session; on the device (deviceCache.ts) for a day. A post's likes and comments
 * are as readable as the post, and only what came back readable is counted (summarizeRelations).
 */
type Kept = { state: State; at: number };
const known = new Map<string, Kept>();
const KEPT_MS = 24 * 60 * 60_000;
/** Kept likes and comments younger than this aren't asked for again. */
const FRESH_MS = 3 * 60_000;
const keptKey = (postId: string) => `post-stats:${postId}`;

const EMPTY: State = {
  likeCount: 0,
  likesTruncated: false,
  likers: [],
  repostCount: 0,
  repostsTruncated: false,
  comments: [],
  commentStats: {},
};

/**
 * A post's likes and comments, and the actions on them. A card reads its likes and the newest page
 * of comments; older comments load only when asked for (loadOlder), so a thread of any length
 * costs the same up front. In a feed room you've joined, a new like or comment re-reads the newest
 * page and merges it in, keeping anything older already loaded. A feed you haven't joined is a
 * snapshot, like its posts.
 *
 * `fresh` (a post's own page): the kept copy still shows at once, but the server is always asked
 * too. That's where a notification of a new comment leads, and the kept copy can predate it.
 */
export function usePostInteractions(roomId: string, postId: string, ownerId: string, postTs: number, { fresh = false } = {}) {
  const mx = useMatrixClient();
  const [state, setState] = useState<State>(() => known.get(postId)?.state ?? EMPTY);
  const [loaded, setLoaded] = useState(false);
  // Whether the server's answer is in yet: until it is, a copy from the device may stand in.
  const answered = useRef(false);
  // When the server last answered (or the kept copy was read, when it was fresh enough to use).
  const answeredAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const alive = useRef(true);
  // Whether "load earlier" has ever run: until it has, the newest page's own cursor is the one to
  // keep; after, the one from the oldest page loaded is, and a refresh mustn't reset it.
  const pagedBack = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [likes, newest, reposts, commentLikes] = await Promise.all([
        limited(() => fetchLikes(mx, roomId, postId, postTs)),
        limited(() => fetchComments(mx, roomId, postId)),
        // A server that can't answer these just shows no repost count, or no counts on comments.
        limited(() => fetchReposts(mx, roomId, postId)).catch(() => undefined),
        limited(() => fetchCommentLikes(mx, roomId, postId, postTs)).catch(() => undefined),
      ]);
      if (!alive.current) return;
      const commentStats =
        reposts || commentLikes
          ? summarizeCommentStats([...(commentLikes ?? []), ...(reposts?.events ?? [])], postId, mx.getUserId() ?? '')
          : undefined;
      answered.current = true;
      answeredAt.current = Date.now();
      setState((prev) => ({
        commentStats: commentStats ?? prev.commentStats,
        ...likes,
        repostCount: reposts?.repostCount ?? prev.repostCount,
        repostsTruncated: reposts?.repostsTruncated ?? prev.repostsTruncated,
        myRepost: reposts ? reposts.mine : prev.myRepost,
        comments: mergeNewestPage(prev.comments, newest.comments),
        older: pagedBack.current ? prev.older : newest.older,
      }));
    } catch {
      // A feed that can't be read right now just shows no likes/comments; the post still renders.
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [mx, roomId, postId, postTs]);

  useEffect(() => {
    alive.current = true;
    pagedBack.current = false;
    answered.current = false;
    let current = true;
    const use = (kept: Kept) => {
      setState(kept.state);
      if (fresh || Date.now() - kept.at >= FRESH_MS || changedSince(kept.at)) return false;
      answered.current = true;
      answeredAt.current = kept.at;
      setLoaded(true);
      return true;
    };
    // Live updates only reach a card while it's on screen: a like or comment that came in through
    // sync while it wasn't (the one a notification is about, say) would be missing from a kept
    // copy that's otherwise still fresh. In a feed room you're in, that shows in its timeline.
    const changedSince = (at: number) =>
      !!mx
        .getRoom(roomId)
        ?.getLiveTimeline()
        .getEvents()
        .some((event) => event.getTs() > at && (event.getRelation()?.event_id === postId || event.getType() === EventType.RoomRedaction));
    const inMemory = known.get(postId);
    setState(EMPTY);
    if (inMemory) {
      if (!use(inMemory)) void reload();
    } else {
      void getCached<Kept>(keptKey(postId)).then((kept) => {
        if (!current || answered.current) return;
        if (!kept?.state || !use(kept)) void reload();
      });
    }
    return () => {
      current = false;
      alive.current = false;
    };
    // `fresh` is fixed for a card's life; `mx` and `roomId` change only with `reload`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, reload]);

  // Kept once the server has answered, and again after each change.
  useEffect(() => {
    if (!loaded || !answered.current) return;
    // A like still on its way isn't one to show next time.
    if (state.myLikeId === 'pending' || Object.values(state.commentStats).some((stats) => stats.myLikeId === 'pending')) return;
    const kept = { state, at: answeredAt.current };
    known.set(postId, kept);
    void putCached(keptKey(postId), kept, KEPT_MS);
  }, [postId, loaded, state]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId !== roomId) return;
      if (event.getType() === EventType.RoomRedaction) {
        // A deleted comment older than the newest page wouldn't show up in a re-read of it.
        const redacted = event.event.redacts ?? (event.getContent() as { redacts?: string }).redacts;
        if (redacted) setState((s) => ({ ...s, comments: s.comments.filter((c) => c.eventId !== redacted) }));
      } else if (event.getRelation()?.event_id !== postId) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 400);
    };
    mx.on(RoomEvent.Timeline, onTimeline);
    return () => {
      clearTimeout(timer);
      mx.removeListener(RoomEvent.Timeline, onTimeline);
    };
  }, [mx, roomId, postId, reload]);

  const loadOlder = async () => {
    const from = state.older;
    if (!from || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchOlderComments(mx, roomId, postId, from, postTs);
      if (!alive.current) return;
      pagedBack.current = true;
      setState((s) => {
        const known = new Set(s.comments.map((c) => c.eventId));
        return { ...s, comments: [...page.comments.filter((c) => !known.has(c.eventId)), ...s.comments], older: page.older };
      });
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  };

  /** Runs an action, then reloads whether it worked or not — so an optimistic like that failed is
   *  put back by the server's answer. The error still reaches the caller to show. */
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      await reload();
      if (alive.current) setBusy(false);
    }
  };

  const toggleLike = () =>
    act(async () => {
      // Shown right away; the reload that follows replaces it with the server's answer.
      if (state.myLikeId) {
        const likeId = state.myLikeId;
        setState((s) => ({ ...s, likeCount: Math.max(0, s.likeCount - 1), myLikeId: undefined }));
        await unlikePost(mx, roomId, likeId);
      } else {
        setState((s) => ({ ...s, likeCount: s.likeCount + 1, myLikeId: 'pending' }));
        await likePost(mx, roomId, postId, ownerId);
      }
    });

  const toggleCommentLike = (commentId: string) =>
    act(async () => {
      const stats = state.commentStats[commentId];
      const bump = (delta: number, myLikeId?: string) =>
        setState((s) => {
          const prev = s.commentStats[commentId] ?? { likeCount: 0, repostCount: 0 };
          const { myLikeId: _old, ...rest } = prev;
          const next = { ...rest, likeCount: Math.max(0, prev.likeCount + delta), ...(myLikeId && { myLikeId }) };
          return { ...s, commentStats: { ...s.commentStats, [commentId]: next } };
        });
      if (stats?.myLikeId) {
        const likeId = stats.myLikeId;
        bump(-1);
        await unlikePost(mx, roomId, likeId);
      } else {
        const comment = state.comments.find((c) => c.eventId === commentId);
        if (!comment) return;
        bump(1, 'pending');
        await likeComment(mx, roomId, postId, { eventId: commentId, sender: comment.sender }, ownerId);
      }
    });

  return {
    ...state,
    loaded,
    busy,
    loadingOlder,
    loadOlder,
    toggleLike,
    toggleCommentLike,
    addComment: (content: PostContent, replyTo?: ReplyTarget) =>
      act(() => sendComment(mx, roomId, postId, ownerId, content, replyTo, replyTo && threadFor(state.comments, replyTo))),
    removeComment: (commentId: string) =>
      act(async () => {
        await deleteComment(mx, roomId, commentId);
        setState((s) => ({ ...s, comments: s.comments.filter((c) => c.eventId !== commentId) }));
      }),
    reload,
  };
}
