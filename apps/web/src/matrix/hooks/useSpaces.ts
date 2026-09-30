import type { Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { useRoomList } from './useRoomList';

function listSpaces(mx: ReturnType<typeof useMatrixClient>): Room[] {
  return mx
    .getRooms()
    .filter((room) => room.isSpaceRoom() && room.getMyMembership() === 'join')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Joined (not merely invited — see useInvites) Matrix Spaces — mapped to Discord "servers" in
 *  the server rail. */
export function useSpaces(): Room[] {
  const mx = useMatrixClient();
  return useRoomList(() => listSpaces(mx), []);
}
