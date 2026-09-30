import { ClientEvent, EventType, RoomEvent, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { readChannelType, SPACE_CHILD_CHANNEL_TYPE_KEY } from './channelType';

function via(mx: MatrixClient): string {
  return mx.getUserId()?.split(':')[1] ?? '';
}

/**
 * Links an *existing* room into a Space as a channel — the create-time version of this already
 * exists in roomCreation.ts's `createRoom`, but there was previously no way to do it for a room
 * that already exists (README's own long-standing "deliberately narrow" list). Sets both
 * directions like creation does: `m.space.child` on the Space is what actually makes
 * useSpaceRooms.ts show it (that's the only side this app itself reads), and `m.space.parent` on
 * the room is the spec's canonical-parent marker for other clients — best-effort, since it needs
 * a state permission in the *room* (not the Space) that we might not have.
 */
export async function addRoomToSpace(mx: MatrixClient, space: Room, room: Room): Promise<void> {
  await mx.sendStateEvent(space.roomId, EventType.SpaceChild, { via: [via(mx)], suggested: false }, room.roomId);
  await mx.sendStateEvent(room.roomId, EventType.SpaceParent, { via: [via(mx)], canonical: true }, space.roomId).catch(() => {
    // Nice-to-have for other clients' breadcrumbs; this app's own channel list doesn't need it.
  });
}

/** Detaches a channel from a Space without leaving/deleting the room itself — per spec, removal
 *  is representing by sending the child event with empty content (no `via`), which is exactly
 *  what useSpaceRooms.ts already treats as "not a child" when reading. A room detached from
 *  every Space it was in reappears under Direct Messages, matching how that view is defined
 *  (useSpacelessRooms.ts: anything not organized under a joined Space) — not a special case. */
export async function removeRoomFromSpace(mx: MatrixClient, spaceId: string, roomId: string): Promise<void> {
  await mx.sendStateEvent(spaceId, EventType.SpaceChild, {}, roomId);
}

/**
 * Rewrites every given room's `order` field to plain zero-padded sequence strings matching the
 * array's order. `order` sorts lexicographically per spec, so a proper implementation would use
 * fractional/between-string indexing to move one item without touching the rest — rewriting all
 * of them on every reorder is simpler and, for the channel-list sizes this app deals with, cheap
 * enough not to bother with that. Preserves each child's existing `via`/`suggested` rather than
 * re-deriving them, since only `order` is changing here.
 *
 * Sent one at a time, not via `Promise.all` — firing several `m.space.child` writes for the same
 * room concurrently was observed (live, against a real Synapse homeserver) to leave one of them
 * stuck showing its pre-reorder content in matrix-js-sdk's own `room.currentState` indefinitely,
 * even though the server had correctly applied every write (confirmed by reading the state back
 * over plain HTTP) — a client-side local-echo/sync-processing race for concurrent same-type
 * state events, not anything wrong with the writes themselves. Sequential sends avoid it.
 */
/** Which joined Space (if any) currently lists this room as a child — used to select the right
 *  server-rail icon when jumping to a room from outside the channel list (e.g. a desktop
 *  notification), since selecting a room alone doesn't imply which Space view should be showing. */
export function findParentSpaceId(mx: MatrixClient, roomId: string): string | null {
  return parentIndex(mx).get(roomId) ?? null;
}

/**
 * Child room -> the first Space listing it, for findParentSpaceId, which runs on every new message
 * in several places (moderation, notifications, mentions) and used to scan every room each time.
 * Built on first use and thrown away when a Space's children change or rooms come and go, so
 * it's rebuilt at most once per such change.
 */
const parentIndexes = new WeakMap<MatrixClient, { index?: Map<string, string> }>();

function buildParentIndex(mx: MatrixClient): Map<string, string> {
  const index = new Map<string, string>();
  for (const space of mx.getRooms()) {
    if (!space.isSpaceRoom()) continue;
    for (const event of space.currentState.getStateEvents(EventType.SpaceChild) as MatrixEvent[]) {
      const childId = event.getStateKey();
      if (childId && !index.has(childId) && (event.getContent().via?.length ?? 0) > 0) index.set(childId, space.roomId);
    }
  }
  return index;
}

function parentIndex(mx: MatrixClient): Map<string, string> {
  // A stand-in client in a test, with nothing to listen to: no cache, always fresh.
  if (typeof mx.on !== 'function') return buildParentIndex(mx);
  let entry = parentIndexes.get(mx);
  if (!entry) {
    const cache: { index?: Map<string, string> } = {};
    const invalidate = () => {
      cache.index = undefined;
      // Once more after the other listeners: one that looked a parent up while the change was
      // still arriving would otherwise have cached the list from before it.
      queueMicrotask(() => {
        cache.index = undefined;
      });
    };
    mx.on(RoomStateEvent.Events, (event: MatrixEvent) => {
      if (event.getType() === EventType.SpaceChild || event.getType() === EventType.RoomCreate) invalidate();
    });
    mx.on(ClientEvent.Room, invalidate);
    mx.on(ClientEvent.DeleteRoom, invalidate);
    mx.on(RoomEvent.MyMembership, invalidate);
    parentIndexes.set(mx, cache);
    entry = cache;
  }
  entry.index ??= buildParentIndex(mx);
  return entry.index;
}

export async function reorderSpaceChildren(mx: MatrixClient, space: Room, orderedRoomIds: string[]): Promise<void> {
  const width = String(orderedRoomIds.length).length;
  for (const [index, roomId] of orderedRoomIds.entries()) {
    const existing = space.currentState.getStateEvents(EventType.SpaceChild, roomId)?.getContent() ?? {};
    const order = String(index).padStart(width, '0');
    await mx.sendStateEvent(space.roomId, EventType.SpaceChild, { ...existing, order }, roomId);
  }
}

/**
 * Voice channels whose link in the Space doesn't yet say they're voice (made before the link
 * carried it, see channelType.ts's SPACE_CHILD_CHANNEL_TYPE_KEY). Pure, for testing.
 */
export function voiceChildrenMissingHint(space: Room, channels: Room[]): Room[] {
  return channels.filter((room) => {
    if (readChannelType(room) !== 'voice') return false;
    const link = space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent();
    return !!link?.via?.length && link[SPACE_CHILD_CHANNEL_TYPE_KEY] !== 'voice';
  });
}

/**
 * Adds the voice marker to those links, keeping everything else on them (order, via). Run by an
 * admin's client, since it's a Space state write. Sequential for the same reason as
 * reorderSpaceChildren.
 */
export async function addVoiceHints(mx: MatrixClient, space: Room, channels: Room[]): Promise<void> {
  for (const room of voiceChildrenMissingHint(space, channels)) {
    const existing = space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent() ?? {};
    const content = { ...existing, [SPACE_CHILD_CHANNEL_TYPE_KEY]: 'voice' };
    await mx.sendStateEvent(space.roomId, EventType.SpaceChild, content as any, room.roomId);
  }
}
