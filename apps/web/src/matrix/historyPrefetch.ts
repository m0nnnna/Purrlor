import { Direction, EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { readFeedMarker } from './feed';
import { warmRoomMedia } from './mediaWarm';

/**
 * Keeps a screenful of history ready in each room, so opening one shows its messages at once
 * instead of waiting on the homeserver (and, for a room on another server, on that server too).
 *
 * The client only gets each room's latest few events from sync, so a room whose last events are
 * reactions, edits or state changes opened empty and had to ask for history first, page by page.
 * After start this fills rooms in the background, most recently active first, a few at a time,
 * while the tab is visible; and a room is filled the moment the pointer rests on it in the channel
 * list. What's fetched stays in the room's timeline for the session (the same one the room view
 * reads). Each room's recent images and avatars are then put in the device's media cache
 * (matrix/mediaWarm.ts), so it opens with those ready too.
 */

/** Messages a room should have ready. */
export const READY_MESSAGES = 30;
/** Rooms filled in the background after start (the rest when hovered or opened). */
const MAX_BACKGROUND_ROOMS = 60;
/** Between two rooms (per worker), so a start with many rooms isn't a burst on the homeserver. */
const GAP_MS = 250;
/** Rooms filled at once. One at a time, a room on a slow server held up every room after it. */
const CONCURRENCY = 3;
/** Pages per room at most: each three times the last when it brought no messages. */
const MAX_PAGES = 4;

const MESSAGE_TYPES = new Set<string>([EventType.RoomMessage, EventType.RoomMessageEncrypted, EventType.Sticker, 'org.matrix.msc3381.poll.start', 'm.poll.start']);

export function messageCount(room: Room): number {
  return room.getLiveTimeline().getEvents().filter((event) => MESSAGE_TYPES.has(event.getType()) && !event.isRedacted()).length;
}

/** Whether a room could use filling: a chat room with fewer messages ready than it should, and more behind them. */
export function needsHistory(room: Room): boolean {
  if (room.isSpaceRoom() || room.getMyMembership() !== 'join') return false;
  // Posts' rooms (feeds, profiles): the feeds page through them themselves.
  if (readFeedMarker(room)) return false;
  if (room.getLiveTimeline().getPaginationToken(Direction.Backward) === null) return false;
  return messageCount(room) < READY_MESSAGES;
}

const inFlight = new Map<string, Promise<void>>();

/** Fills one room's timeline up to READY_MESSAGES (or its start). Shares a fill already running. */
export function prefetchHistory(mx: MatrixClient, room: Room): Promise<void> {
  const running = inFlight.get(room.roomId);
  if (running) return running;
  const fill = (async () => {
    let limit = READY_MESSAGES;
    for (let page = 0; page < MAX_PAGES && needsHistory(room); page++) {
      const before = messageCount(room);
      const more = await mx.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit });
      if (!more) break;
      if (messageCount(room) === before) limit = Math.min(600, limit * 3);
    }
  })()
    .catch(() => undefined)
    .finally(() => inFlight.delete(room.roomId));
  inFlight.set(room.roomId, fill);
  return fill;
}

/** About to be opened (the pointer resting on it): its history filled, then its media warmed. */
export function prepareRoom(mx: MatrixClient, room: Room): void {
  void (needsHistory(room) ? prefetchHistory(mx, room) : Promise.resolve())
    .then(() => warmRoomMedia(mx, room))
    .catch(() => undefined);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function whenVisible(): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return;
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', onChange);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

/**
 * Fills the most recently active rooms that need it, one at a time, after start. Returns a stop
 * function (sign-out, unmount). `wait` is for tests.
 */
export function startHistoryPrefetch(mx: MatrixClient, { gapMs = GAP_MS, wait = sleep, concurrency = CONCURRENCY } = {}): () => void {
  let stopped = false;
  const rooms = mx
    .getRooms()
    .filter((room) => !room.isSpaceRoom() && room.getMyMembership() === 'join' && !readFeedMarker(room))
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp())
    .slice(0, MAX_BACKGROUND_ROOMS);
  const worker = async () => {
    for (let room = rooms.shift(); room; room = rooms.shift()) {
      if (stopped) return;
      await whenVisible();
      if (stopped) return;
      if (needsHistory(room)) {
        await prefetchHistory(mx, room);
        await wait(gapMs);
      }
      void warmRoomMedia(mx, room).catch(() => undefined);
    }
  };
  for (let i = 0; i < concurrency; i++) void worker();
  return () => {
    stopped = true;
  };
}
