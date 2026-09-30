import { EventType, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { CHANNEL_TYPE_EVENT, readChannelType } from '../channelType';
import { useRoomList } from './useRoomList';
import { isBackgroundRoom } from '../backgroundRooms';

function getSpaceChildRoomIds(mx: ReturnType<typeof useMatrixClient>): Set<string> {
  const childIds = new Set<string>();
  mx.getRooms()
    .filter((room) => room.isSpaceRoom())
    .forEach((space) => {
      const childEvents = space.currentState.getStateEvents(EventType.SpaceChild) as MatrixEvent[];
      childEvents.forEach((event) => {
        const content = event.getContent<{ via?: string[] }>();
        if (content.via && content.via.length > 0) {
          childIds.add(event.getStateKey() ?? '');
        }
      });
    });
  return childIds;
}

function listSpacelessRooms(mx: ReturnType<typeof useMatrixClient>): Room[] {
  const spaceChildIds = getSpaceChildRoomIds(mx);
  // A room you're only invited to (not joined) is surfaced through useInvites instead.
  return mx
    .getRooms()
    .filter(
      (room) =>
        !room.isSpaceRoom() &&
        !spaceChildIds.has(room.roomId) &&
        room.getMyMembership() === 'join' &&
        // Feed rooms are joined in bulk to read the hub's posts (feed.ts's followSpaceFeeds) and
        // are deliberately never Space children, so without this every member's timeline would
        // land here as a "group chat" — one row per person in the hub.
        readChannelType(room) !== 'feed' &&
        // The global emote library (emoteLibrary.ts) is joined by everyone in the background.
        !isBackgroundRoom(room)
    )
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
}

/**
 * Rooms not organized under any joined Space — covers both 1:1 direct messages and Matrix's
 * plain multi-person "group chat" rooms. The protocol has no separate concept for a group
 * chat: it's just a room with more than two members that nobody's put in a Space, so a room
 * qualifies here purely by "not a space, not a child of any joined space" rather than any
 * member-count or `m.direct` heuristic. Shown together in the pinned Direct Messages section,
 * matching how Discord's own DM rail mixes 1:1 and group DMs in one list.
 */
export function useSpacelessRooms(): Room[] {
  const mx = useMatrixClient();
  return useRoomList(() => listSpacelessRooms(mx), [], {
    // A room moving into or out of a Space, or becoming a feed; and new messages, for the order.
    isRelevant: (event) => event.getType() === EventType.SpaceChild || event.getType() === CHANNEL_TYPE_EVENT,
    timeline: true,
  });
}
