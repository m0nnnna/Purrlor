import { Direction, EventType, Method, RelationType, type MatrixClient } from 'matrix-js-sdk';
import { listOwnFeedRoomIds } from './feed';
import { readFreshAccountData } from './freshAccountData';
import { readMentionInbox, type MentionRef } from './mentionInbox';
import { COMMENT_EVENT_TYPE, COMMENT_LIKE_TYPE, LIKE_KEY, REPOST_RECEIPT_TYPE } from './postInteractions';
import { FOLLOWED_EVENT, getOwnProfileRoomId } from './profileFeed';

/**
 * Activity — the Notifications page: likes, comments, replies, reposts and quotes of your posts,
 * new followers, and mentions of you anywhere (posts, comments and chat).
 *
 * Nearly all of it is already delivered to you, because it lands in **your own feed rooms** (your
 * profile feed and your feed in each Space): a like, a comment, a repost marker
 * (postInteractions.ts) and a follow notice (profileFeed.ts) are all events in the room of the
 * post or profile they're about, and you're always in your own. So Activity is read straight from
 * those rooms' recent history — nothing extra to collect or store, and it's complete across
 * devices and time spent offline.
 *
 * What happens *elsewhere* is being mentioned: in a channel, or in or under someone else's post.
 * Those come from the mention inbox (mentionInbox.ts), which records every message, post and
 * comment that mentions you — and a reply always mentions whoever it answers.
 *
 * What you've seen is a timestamp in account data, so the unread dot clears on every device.
 */
export type ActivityKind = 'like' | 'comment' | 'reply' | 'thread' | 'commentLike' | 'mention' | 'repost' | 'quote' | 'follow';

export type ActivityItem = {
  /** Stable key: the event for a single item, the post (or day) for a grouped one. */
  key: string;
  kind: ActivityKind;
  /** Newest first, one entry each. */
  senders: string[];
  /** When the newest of it happened. */
  ts: number;
  /** The room the newest event is in, and the event: what a comment/reply/mention shows. */
  roomId: string;
  eventId: string;
  /** The post it's about — yours, or for a mention/reply, the post it's in or under. None for a
   *  chat mention, which opens at its message in its channel. */
  postId?: string;
  /** A quote: the quoting post (it lives in the quoter's own feed). */
  quote?: { roomId: string; eventId: string };
  /** A like on your comment: the comment (in the same room). */
  commentId?: string;
  /** A chat mention you've already read in its channel (markChannelReads): it stops counting as new. */
  readInChannel?: boolean;
};

/** Whether an item is new to you: newer than what you last looked at here, and not a chat mention
 *  you've already read where it was said. */
export function isUnread(item: ActivityItem, seenTs: number): boolean {
  return item.ts > seenTs && !item.readInChannel;
}

/**
 * Marks the chat mentions in `items` that your read receipt in their channel already covers, so
 * reading a message where it was said clears it here too, without opening Notifications. Posts and
 * comments have no read receipts, so those stay new until you look here. Returns the same array
 * when nothing changed. Pure over what the room has loaded.
 */
export function markChannelReads(mx: MatrixClient, items: ActivityItem[]): ActivityItem[] {
  const myUserId = mx.getUserId();
  if (!myUserId) return items;
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== 'mention' || item.postId) return item;
    const read = !!mx.getRoom(item.roomId)?.hasUserReadEvent(myUserId, item.eventId);
    if (read === !!item.readInChannel) return item;
    changed = true;
    return { ...item, readInChannel: read };
  });
  return changed ? next : items;
}

export type RawActivityEvent = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: { redacted_because?: unknown };
};

/** Likes and reposts of one post, and follows on one day, are one row each: "Ana and 3 others". */
const GROUPED: ActivityKind[] = ['like', 'repost', 'follow'];

type Classified = Omit<ActivityItem, 'key' | 'senders'> & { sender: string };

function relationOf(event: RawActivityEvent): { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined {
  return event.content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined;
}

/** One event from your own feed rooms, as activity — or undefined if it's none. */
function classify(event: RawActivityEvent, myUserId: string): Classified | undefined {
  if (event.sender === myUserId || event.unsigned?.redacted_because) return undefined;
  const base = { sender: event.sender, ts: event.origin_server_ts, roomId: event.room_id, eventId: event.event_id };
  const relation = relationOf(event);
  const postId = typeof relation?.event_id === 'string' ? relation.event_id : undefined;

  if (event.type === EventType.Reaction) {
    return relation?.rel_type === RelationType.Annotation && relation.key === LIKE_KEY && postId
      ? { ...base, kind: 'like', postId }
      : undefined;
  }
  if (event.type === COMMENT_EVENT_TYPE) {
    if (relation?.rel_type !== RelationType.Reference || !postId) return undefined;
    const replyTo = event.content['xyz.nekous.reply_to'] as { sender?: unknown } | undefined;
    return { ...base, kind: replyTo?.sender === myUserId ? 'reply' : 'comment', postId };
  }
  if (event.type === REPOST_RECEIPT_TYPE) {
    if (relation?.rel_type !== RelationType.Reference || !postId) return undefined;
    // A repost of a comment under your post isn't a repost of your post.
    if (typeof event.content['xyz.nekous.comment'] === 'string') return undefined;
    const target = event.content['xyz.nekous.repost_event'] as
      | { room_id?: unknown; event_id?: unknown; quote?: unknown }
      | undefined;
    if (target?.quote === true && typeof target.room_id === 'string' && typeof target.event_id === 'string') {
      return { ...base, kind: 'quote', postId, quote: { roomId: target.room_id, eventId: target.event_id } };
    }
    return { ...base, kind: 'repost', postId };
  }
  if (event.type === FOLLOWED_EVENT) return { ...base, kind: 'follow' };
  return undefined;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Raw events → activity rows, newest first. Likes and reposts group per post and follows per
 * day; everything else is a row of its own. Pure, so it's tested without a server.
 */
export function buildActivity(events: RawActivityEvent[], myUserId: string): ActivityItem[] {
  const seenEvents = new Set<string>();
  const rows = new Map<string, ActivityItem>();
  const sorted = [...events].sort((a, b) => b.origin_server_ts - a.origin_server_ts);

  for (const event of sorted) {
    if (seenEvents.has(event.event_id)) continue;
    seenEvents.add(event.event_id);
    const item = classify(event, myUserId);
    if (!item) continue;
    const { sender, ...rest } = item;
    const key = GROUPED.includes(item.kind)
      ? `${item.kind}|${item.kind === 'follow' ? dayOf(item.ts) : item.postId}`
      : event.event_id;
    const existing = rows.get(key);
    if (existing) {
      // Older than what's there (sorted newest first): it only adds a name.
      if (!existing.senders.includes(sender)) existing.senders.push(sender);
    } else {
      rows.set(key, { ...rest, key, senders: [sender] });
    }
  }
  return [...rows.values()].sort((a, b) => b.ts - a.ts);
}

/** How many of the newest events of the kinds above to read from each of your feed rooms. */
const PER_ROOM = 100;
const ACTIVITY_TYPES: string[] = [EventType.Reaction, COMMENT_EVENT_TYPE, REPOST_RECEIPT_TYPE, FOLLOWED_EVENT];

/** Your profile feed and your feed in each Space — where activity about you lands. */
export function ownFeedRoomIds(mx: MatrixClient): string[] {
  const profile = getOwnProfileRoomId(mx);
  return [...new Set([...(profile ? [profile] : []), ...listOwnFeedRoomIds(mx)])];
}

/** Whether an event is the kind Activity is made of — for noticing new activity as it arrives. */
export function isActivityEventType(type: string): boolean {
  return ACTIVITY_TYPES.includes(type);
}

async function recentEvents(mx: MatrixClient, roomId: string): Promise<RawActivityEvent[]> {
  const res = await mx.http.authedRequest<{ chunk?: Omit<RawActivityEvent, 'room_id'>[] }>(
    Method.Get,
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    { dir: Direction.Backward, limit: String(PER_ROOM), filter: JSON.stringify({ types: ACTIVITY_TYPES }) }
  );
  return (res.chunk ?? []).map((event) => ({ ...event, room_id: roomId }));
}

export type MentionEvent = { event: RawActivityEvent; postId?: string };

/** One mention inbox entry read back, to know who and what it is: from memory when the room has
 *  it (already decrypted, in an encrypted channel), else from the server. */
async function readMention(mx: MatrixClient, ref: MentionRef): Promise<MentionEvent | undefined> {
  const local = mx.getRoom(ref.roomId)?.findEventById(ref.eventId);
  if (local) {
    const event: RawActivityEvent = {
      event_id: ref.eventId,
      room_id: ref.roomId,
      type: local.getType(),
      sender: local.getSender() ?? '',
      origin_server_ts: local.getTs(),
      content: local.getContent(),
      unsigned: local.isRedacted() ? { redacted_because: true } : undefined,
    };
    return { event, postId: ref.postId };
  }
  try {
    const raw = (await mx.fetchRoomEvent(ref.roomId, ref.eventId)) as unknown as Omit<RawActivityEvent, 'room_id'>;
    return { event: { ...raw, room_id: ref.roomId }, postId: ref.postId };
  } catch {
    return undefined;
  }
}

/**
 * What a mention of you in a comment means: a reply to your comment, a reply in a thread you've
 * written in (threads mention everyone in them, postInteractions.ts), or a plain @-mention.
 */
function commentMentionKind(content: Record<string, unknown>, myUserId: string): ActivityKind {
  const replyTo = content['xyz.nekous.reply_to'] as { sender?: unknown } | undefined;
  if (replyTo?.sender === myUserId) return 'reply';
  // In a thread, and not named in the words themselves: it reached you as one of the thread.
  const body = typeof content.body === 'string' ? content.body : '';
  const formatted = typeof content.formatted_body === 'string' ? content.formatted_body : '';
  const named = body.includes(myUserId) || formatted.includes(myUserId) || formatted.includes(encodeURIComponent(myUserId));
  if (typeof content['xyz.nekous.thread'] === 'string' && !named) return 'thread';
  return 'mention';
}

/**
 * Mention inbox entries → activity rows, leaving out what your own rooms already showed (a comment
 * on your post that also mentions you is one row, not two). A comment answering you is a reply,
 * one in your thread a thread reply, a like on your comment a comment like; anything else is a
 * mention. Pure, so it's tested without a server.
 */
export function buildMentionActivity(mentions: MentionEvent[], alreadyShown: Set<string>, myUserId: string): ActivityItem[] {
  return mentions
    .filter(({ event }) => !alreadyShown.has(event.event_id) && event.sender !== myUserId && !event.unsigned?.redacted_because)
    .map(({ event, postId }): ActivityItem => {
      const commentId = event.content['xyz.nekous.comment'];
      const kind: ActivityKind =
        event.type === COMMENT_LIKE_TYPE ? 'commentLike' : event.type === COMMENT_EVENT_TYPE ? commentMentionKind(event.content, myUserId) : 'mention';
      return {
        key: event.event_id,
        kind,
        ...(kind === 'commentLike' && typeof commentId === 'string' && { commentId }),
        senders: [event.sender],
        ts: event.origin_server_ts,
        roomId: event.room_id,
        eventId: event.event_id,
        ...(postId && { postId }),
      };
    });
}

/**
 * Reads Activity, remembering what it read so the next read fetches only what changed. It used to
 * read everything fresh each time — 100 events from each of your feed rooms and every mention in
 * the inbox, one request each — every five minutes and after every burst of likes. Now:
 *
 * - `read()` with no rooms re-reads every feed room (the periodic safety net); with `rooms`, only
 *   those (the one a like just landed in). A feed room never read yet is always read.
 * - A mention is read back once and kept: its words don't change, and one deleted since is
 *   dropped with `forget` when its redaction arrives. Entries that leave the inbox are dropped.
 *
 * A room that can't be read right now keeps what was last read from it, rather than emptying.
 */
export function createActivityReader(mx: MatrixClient) {
  const perRoom = new Map<string, RawActivityEvent[]>();
  const mentions = new Map<string, MentionEvent | undefined>();
  const keyOf = (roomId: string, eventId: string) => `${roomId}|${eventId}`;

  return {
    async read({ rooms }: { rooms?: string[] } = {}): Promise<ActivityItem[]> {
      const myUserId = mx.getUserId() ?? '';
      const own = ownFeedRoomIds(mx);
      const toRead = own.filter((roomId) => !rooms || rooms.includes(roomId) || !perRoom.has(roomId));
      const refs = readMentionInbox(mx);
      await Promise.all([
        ...toRead.map(async (roomId) => {
          const events = await recentEvents(mx, roomId).catch(() => undefined);
          if (events) perRoom.set(roomId, events);
        }),
        ...refs
          .filter((ref) => !mentions.has(keyOf(ref.roomId, ref.eventId)))
          .map(async (ref) => mentions.set(keyOf(ref.roomId, ref.eventId), await readMention(mx, ref).catch(() => undefined))),
      ]);
      for (const roomId of [...perRoom.keys()]) if (!own.includes(roomId)) perRoom.delete(roomId);
      const inInbox = new Set(refs.map((ref) => keyOf(ref.roomId, ref.eventId)));
      for (const key of [...mentions.keys()]) if (!inInbox.has(key)) mentions.delete(key);

      const fromOwn = buildActivity([...perRoom.values()].flat(), myUserId);
      const elsewhere = buildMentionActivity(
        [...mentions.values()].filter((m): m is MentionEvent => !!m),
        new Set(fromOwn.map((item) => item.eventId)),
        myUserId
      );
      return markChannelReads(mx, [...fromOwn, ...elsewhere].sort((a, b) => b.ts - a.ts));
    },
    /** Whether this event is a mention it holds; forgets it if so (it was deleted). */
    forget(roomId: string, eventId: string): boolean {
      return mentions.delete(keyOf(roomId, eventId));
    },
  };
}

export type ActivityReader = ReturnType<typeof createActivityReader>;

export const ACTIVITY_SEEN_ACCOUNT_DATA = 'xyz.nekous.activity_seen';

export function readActivitySeen(mx: MatrixClient): number {
  const ts = mx.getAccountData(ACTIVITY_SEEN_ACCOUNT_DATA as any)?.getContent<{ ts?: unknown }>()?.ts;
  return typeof ts === 'number' ? ts : 0;
}

/** Marks everything up to `ts` seen — never moving backwards, if another device got further. */
export async function markActivitySeen(mx: MatrixClient, ts: number): Promise<void> {
  const fresh = await readFreshAccountData<{ ts?: unknown }>(mx, ACTIVITY_SEEN_ACCOUNT_DATA);
  const current = typeof fresh?.ts === 'number' ? fresh.ts : 0;
  if (ts > current) await mx.setAccountData(ACTIVITY_SEEN_ACCOUNT_DATA as any, { ts } as any);
}
