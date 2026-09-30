import { EventType, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { useRoomList } from './useRoomList';

type SpaceChildContent = { via?: string[]; order?: string };

/**
 * Rooms under a Space, resolved from `m.space.child` state events — mapped to Discord
 * "channels". Deletion is represented per-spec by an empty content (no `via`), so that's
 * treated as "not a child". Ordering follows the spec's `order` field (lexicographic string
 * sort), falling back to room name for children without one. Sub-spaces are excluded — nested
 * space navigation isn't in scope yet.
 */
function listChildRooms(mx: ReturnType<typeof useMatrixClient>, spaceId: string): Room[] {
  const space = mx.getRoom(spaceId);
  if (!space) return [];

  const childEvents = space.currentState.getStateEvents(EventType.SpaceChild) as MatrixEvent[];
  const children: { room: Room; order?: string }[] = [];

  childEvents.forEach((event) => {
    const content = event.getContent<SpaceChildContent>();
    if (!content.via || content.via.length === 0) return;
    const room = mx.getRoom(event.getStateKey() ?? '');
    // A room you're only invited to (not joined) is surfaced through useInvites instead — see
    // its own comment for why nothing here used to filter on membership at all.
    if (room && !room.isSpaceRoom() && room.getMyMembership() === 'join') {
      children.push({ room, order: content.order });
    }
  });

  children.sort((a, b) => {
    if (a.order && b.order) return a.order.localeCompare(b.order);
    if (a.order) return -1;
    if (b.order) return 1;
    return a.room.name.localeCompare(b.room.name);
  });

  return children.map((c) => c.room);
}

export function useSpaceRooms(spaceId: string | null): Room[] {
  const mx = useMatrixClient();
  return useRoomList(() => (spaceId ? listChildRooms(mx, spaceId) : []), [spaceId], {
    // Only this Space's list of children changes which rooms are in it.
    isRelevant: (event) => event.getType() === EventType.SpaceChild && event.getRoomId() === spaceId,
  });
}
