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

/**
 * For a channel set to "Only @mentions" or "Nothing" (matrix/notificationSettings.ts): the
 * counts above stay at zero for plain messages there, so they can't say whether it has anything
 * new. This can. `enabled` false skips the work for rooms the counts already cover.
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
