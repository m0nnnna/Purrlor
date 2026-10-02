import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { readChannelType } from './channelType';
import { isBackgroundRoom } from './backgroundRooms';

function getSpaceChildRoomIds(mx: MatrixClient): Set<string> {
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

export function listSpacelessRooms(mx: MatrixClient): Room[] {
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
