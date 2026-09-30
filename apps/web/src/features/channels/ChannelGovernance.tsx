import { useEffect } from 'react';
import { EventType, RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readLeftChannels } from '../../matrix/autoJoin';
import { CHANNEL_SETTINGS_EVENT, governChannel, governSpaces, inviteFromSpaceModerator } from '../../matrix/channelPermissions';
import { MODERATION_EVENT, readModerationConfig, reviewRoomInviteFromModerator, spaceOfReviewRoom } from '../../matrix/reports';
import { findParentSpaceId } from '../../matrix/spaceChildren';

/** State that changes what a Space's channels should look like. */
const SPACE_STATE = new Set<string>([EventType.RoomPowerLevels, EventType.RoomMember, EventType.SpaceChild, MODERATION_EVENT]);
const CHANNEL_STATE = new Set<string>([EventType.RoomPowerLevels, EventType.RoomMember, CHANNEL_SETTINGS_EVENT]);

/**
 * Keeps the channels of your Spaces in line with them (matrix/channelPermissions.ts): the Space's
 * moderators and admins copied into each channel's power levels, and moderators-only channels'
 * members kept to the Space's moderators — as far as you're allowed to change each channel.
 * Once at start for every Space, then for one Space when its roles, members or channels change,
 * or one of its channels' do. Also accepts invites from a Space's moderators to its channels,
 * which is how a moderators-only channel reaches a new moderator. Headless, mounted in AppShell.
 */
export function ChannelGovernance() {
  const mx = useMatrixClient();

  useEffect(() => {
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued: 'all' | Set<string> | undefined;

    const run = async () => {
      if (running) return; // the finally below picks up whatever was queued meanwhile
      running = true;
      const spaceIds = queued === 'all' ? undefined : queued;
      queued = undefined;
      try {
        await governSpaces(mx, spaceIds);
        // A Space's review room (reports.ts) is moderators-only too, though not one of its channels.
        const spaces = spaceIds ? [...spaceIds].flatMap((id) => mx.getRoom(id) ?? []) : mx.getRooms().filter((r) => r.isSpaceRoom());
        for (const space of spaces) {
          const reviewRoom = mx.getRoom(readModerationConfig(space).reviewRoomId ?? '');
          if (reviewRoom) await governChannel(mx, reviewRoom, space).catch((err: unknown) => console.warn('Couldn’t update the review room', err));
        }
      } finally {
        running = false;
        if (queued) startTimer();
      }
    };
    const startTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 2000);
    };
    const queue = (spaceId: string | 'all') => {
      if (spaceId === 'all') queued = 'all';
      else if (queued !== 'all') queued = new Set([...(queued ?? []), spaceId]);
      startTimer();
    };

    const acceptIfFromModerator = (room: Room) => {
      if (readLeftChannels(mx).has(room.roomId)) return;
      if (inviteFromSpaceModerator(mx, room) || reviewRoomInviteFromModerator(mx, room)) {
        mx.joinRoom(room.roomId).catch((err: unknown) => console.warn('Couldn’t accept a channel invite', err));
      }
    };

    const onState = (event: MatrixEvent) => {
      const roomId = event.getRoomId();
      const room = roomId ? mx.getRoom(roomId) : null;
      if (!room) return;
      if (room.isSpaceRoom()) {
        if (SPACE_STATE.has(event.getType())) queue(room.roomId);
        return;
      }
      if (!CHANNEL_STATE.has(event.getType())) return;
      const spaceId = findParentSpaceId(mx, room.roomId) ?? spaceOfReviewRoom(mx, room.roomId)?.roomId;
      if (spaceId) queue(spaceId);
    };
    const onMembership = (room: Room, membership: string) => {
      if (membership === 'invite') acceptIfFromModerator(room);
    };

    queue('all');
    mx.getRooms().forEach(acceptIfFromModerator);
    mx.on(RoomStateEvent.Events, onState);
    mx.on(RoomEvent.MyMembership, onMembership);
    return () => {
      clearTimeout(timer);
      mx.removeListener(RoomStateEvent.Events, onState);
      mx.removeListener(RoomEvent.MyMembership, onMembership);
    };
  }, [mx]);

  return null;
}
