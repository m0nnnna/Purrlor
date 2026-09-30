import { EventType, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { useRoomList } from './useRoomList';
import { readMentionInvite } from '../mentionInvites';

function listInvites(mx: ReturnType<typeof useMatrixClient>): Room[] {
  return mx
    .getRooms()
    .filter((room) => room.getMyMembership() === 'invite')
    // A Global-post mention arrives as an invite and is accepted by itself (mentionInvites.ts).
    .filter((room) => !readMentionInvite(mx, room))
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
}

/**
 * Every room this account has been invited to but hasn't joined or declined yet — Spaces,
 * channels, and DMs alike, since Matrix invites work identically regardless of room type (see
 * classifyInvite in matrix/invites.ts for how InvitesModal tells them apart for display).
 * Previously nothing filtered on membership anywhere: an invited room already got a local `Room`
 * object the moment it arrived over `/sync`, so it silently showed up in the normal server
 * rail/channel list/DM list as if already joined — clickable, but useless, since you can't read
 * a room's timeline before joining it. useSpaces/useSpaceRooms/useSpacelessRooms all now exclude
 * invite-state rooms so this is the one place they surface instead, with a real Accept/Decline.
 */
export function useInvites(): Room[] {
  const mx = useMatrixClient();
  return useRoomList(() => listInvites(mx), [], {
    // Your own invite (and its reason), and what kind of room it is: what tells a mention's invite apart.
    isRelevant: (event) =>
      (event.getType() === EventType.RoomMember && event.getStateKey() === mx.getUserId()) || event.getType() === EventType.RoomCreate,
  });
}
