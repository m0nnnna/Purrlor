import { useEffect, useState } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { SPACE_ORDER_EVENT, sortSpaces } from '../spaceOrder';
import { useRoomList } from './useRoomList';

function listSpaces(mx: ReturnType<typeof useMatrixClient>): Room[] {
  return sortSpaces(mx.getRooms().filter((room) => room.isSpaceRoom() && room.getMyMembership() === 'join'));
}

/** Joined (not merely invited — see useInvites) Matrix Spaces — mapped to Discord "servers" in
 *  the server rail — in your order (matrix/spaceOrder.ts), which follows you to other devices. */
export function useSpaces(): Room[] {
  const mx = useMatrixClient();
  // Your order is room account data, which the room list doesn't watch: a change to it re-sorts.
  const [orderChanges, setOrderChanges] = useState(0);
  useEffect(() => {
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === SPACE_ORDER_EVENT) setOrderChanges((n) => n + 1);
    };
    mx.on(RoomEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(RoomEvent.AccountData, onAccountData);
    };
  }, [mx]);
  return useRoomList(() => listSpaces(mx), [orderChanges]);
}
