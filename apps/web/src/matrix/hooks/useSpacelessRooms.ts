import { EventType, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { CHANNEL_TYPE_EVENT } from '../channelType';
import { listSpacelessRooms } from '../spacelessRooms';
import { useRoomList } from './useRoomList';

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
