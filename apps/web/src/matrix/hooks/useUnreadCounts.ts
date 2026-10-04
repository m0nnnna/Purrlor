import { useEffect, useState } from 'react';
import { NotificationCountType, RoomEvent, type Room } from 'matrix-js-sdk';

export type UnreadCount = { total: number; highlight: number };

function readCount(room: Room): UnreadCount {
  return {
    total: room.getUnreadNotificationCount(NotificationCountType.Total),
    highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight),
  };
}

/**
 * One room's unread/notification counts. These are server-computed (`unread_notifications` in
 * every `/sync` response) so they already respect push rules — an `@mention` counting as a
 * "highlight" is the server's own push-rule evaluation, not something this app reimplements.
 * See MessageTimeline.tsx for the other half of this: sending the `m.read` receipt that's what
 * actually clears these server-side when a room is read.
 */
export function useRoomUnreadCount(room: Room | null): UnreadCount {
  const [count, setCount] = useState<UnreadCount>(() => (room ? readCount(room) : { total: 0, highlight: 0 }));

  useEffect(() => {
    if (!room) {
      setCount({ total: 0, highlight: 0 });
      return undefined;
    }
    const update = () => setCount(readCount(room));
    update();
    room.on(RoomEvent.UnreadNotifications, update);
    return () => {
      room.removeListener(RoomEvent.UnreadNotifications, update);
    };
  }, [room]);

  return count;
}

/** Event types that make a channel "unread" when someone else sends them. */
const UNREAD_TYPES = new Set(['m.room.message', 'm.room.encrypted', 'm.sticker', 'org.matrix.msc3381.poll.start', 'm.poll.start']);

/** Whether someone else has said something since your read receipt, whatever your push rules
 *  make of it. Only looks at what's loaded in the live timeline, which after sync is at least
 *  the latest message. */
export function hasUnreadMessages(room: Room, userId: string): boolean {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.getSender() === userId) return false;
    if (UNREAD_TYPES.has(event.getType()) && !event.isRedacted()) {
      const eventId = event.getId();
      return !!eventId && !room.hasUserReadEvent(userId, eventId);
    }
  }
  return false;
}

/** How many messages others have sent since your read receipt (at most `cap`), counted from the
 *  loaded live timeline. Unlike the server's counts it covers encrypted rooms (an undecryptable
 *  message still counts) and doesn't depend on push rules: what a DM's badge shows. */
export function countUnreadMessages(room: Room, userId: string, cap = 100): number {
  const events = room.getLiveTimeline().getEvents();
  let count = 0;
  for (let i = events.length - 1; i >= 0 && count < cap; i--) {
    const event = events[i];
    if (event.getSender() === userId) break;
    const eventId = event.getId();
    if (eventId && room.hasUserReadEvent(userId, eventId)) break;
    if (UNREAD_TYPES.has(event.getType()) && !event.isRedacted()) count++;
  }
  return count;
}

/** A DM's unread count for its badge: every message counts, as a mention would in a channel. The
 *  larger of the server's count and the one counted here, since each can miss what the other sees
 *  (the server, encrypted messages; this, anything older than the loaded timeline). */
export function directMessageUnread(room: Room, userId: string): number {
  return Math.max(room.getUnreadNotificationCount(NotificationCountType.Total), countUnreadMessages(room, userId));
}

/** Calls `update` on whatever can change a DM's count: a message, a read receipt, new counts. */
function onDirectMessageActivity(room: Room, update: () => void): () => void {
  room.on(RoomEvent.Timeline, update);
  room.on(RoomEvent.Receipt, update);
  room.on(RoomEvent.UnreadNotifications, update);
  return () => {
    room.removeListener(RoomEvent.Timeline, update);
    room.removeListener(RoomEvent.Receipt, update);
    room.removeListener(RoomEvent.UnreadNotifications, update);
  };
}

/**
 * Each DM's unread count (directMessageUnread), for the rooms given, leaving out any muted ones
 * (`isMuted`). Recounted whenever one of them gets a message, a read receipt or new counts.
 */
export function useDirectMessageUnreads(rooms: Room[], userId: string, isMuted: (roomId: string) => boolean): Map<string, number> {
  const [, forceRender] = useState(0);
  const roomIdsKey = rooms.map((room) => room.roomId).join(',');

  useEffect(() => {
    const update = () => forceRender((n) => n + 1);
    const unsubscribes = rooms.map((room) => onDirectMessageActivity(room, update));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdsKey]);

  const counts = new Map<string, number>();
  for (const room of rooms) {
    if (isMuted(room.roomId)) continue;
    const count = directMessageUnread(room, userId);
    if (count > 0) counts.set(room.roomId, count);
  }
  return counts;
}

/** One DM row's unread count (directMessageUnread), kept current. 0 when `enabled` is false. */
export function useDirectMessageUnread(room: Room, userId: string, enabled: boolean): number {
  const [count, setCount] = useState(() => (enabled ? directMessageUnread(room, userId) : 0));

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return undefined;
    }
    const update = () => setCount(directMessageUnread(room, userId));
    update();
    return onDirectMessageActivity(room, update);
  }, [room, userId, enabled]);

  return count;
}

/**
 * Whether a channel has anything new, from read receipts rather than the server's counts. The
 * counts follow push rules, so they stay at zero for whatever those keep quiet: every plain
 * message under "Only @mentions", and under "All messages" too for `m.notice` (webhooks, bots,
 * automod), which the default rules never count. A channel whose only news was a webhook post was
 * never shown as unread. `enabled` false skips the work (a muted channel stays quiet regardless).
 */
export function useRoomHasUnread(room: Room, userId: string, enabled: boolean): boolean {
  const [unread, setUnread] = useState(() => enabled && hasUnreadMessages(room, userId));

  useEffect(() => {
    if (!enabled) {
      setUnread(false);
      return undefined;
    }
    const update = () => setUnread(hasUnreadMessages(room, userId));
    update();
    room.on(RoomEvent.Timeline, update);
    room.on(RoomEvent.Receipt, update);
    return () => {
      room.removeListener(RoomEvent.Timeline, update);
      room.removeListener(RoomEvent.Receipt, update);
    };
  }, [room, userId, enabled]);

  return unread;
}

/**
 * Whether any of `rooms` has something new (hasUnreadMessages), leaving out muted ones (`isMuted`):
 * the unread mark on a collapsed category and on a Space's tile in the rail, which the server's
 * counts alone miss the same way a channel's do (useRoomHasUnread).
 */
export function useAnyRoomHasUnread(rooms: Room[], userId: string, isMuted: (roomId: string) => boolean): boolean {
  const [, forceRender] = useState(0);
  const roomIdsKey = rooms.map((room) => room.roomId).join(',');

  useEffect(() => {
    const update = () => forceRender((n) => n + 1);
    rooms.forEach((room) => {
      room.on(RoomEvent.Timeline, update);
      room.on(RoomEvent.Receipt, update);
    });
    return () => {
      rooms.forEach((room) => {
        room.removeListener(RoomEvent.Timeline, update);
        room.removeListener(RoomEvent.Receipt, update);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdsKey]);

  return rooms.some((room) => !isMuted(room.roomId) && hasUnreadMessages(room, userId));
}

/** Aggregate unread/notification counts across a list of rooms — used for the server rail's
 *  per-Space badge (sum of its channels) and the Home/DM icon's badge (sum of all DMs). Keys
 *  its subscription on the room IDs themselves rather than the array reference, since callers
 *  like useSpaceRooms/useSpacelessRooms return a fresh array on every relevant update. */
export function useUnreadSummary(rooms: Room[]): UnreadCount {
  const [, forceRender] = useState(0);
  const roomIdsKey = rooms.map((room) => room.roomId).join(',');

  useEffect(() => {
    const update = () => forceRender((n) => n + 1);
    rooms.forEach((room) => room.on(RoomEvent.UnreadNotifications, update));
    return () => {
      rooms.forEach((room) => room.removeListener(RoomEvent.UnreadNotifications, update));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdsKey]);

  return rooms.reduce<UnreadCount>(
    (acc, room) => {
      const c = readCount(room);
      return { total: acc.total + c.total, highlight: acc.highlight + c.highlight };
    },
    { total: 0, highlight: 0 }
  );
}
