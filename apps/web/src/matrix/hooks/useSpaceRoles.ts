import { useEffect, useMemo, useState } from 'react';
import { RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { readSpaceRoles, ROLES_EVENT, type RoleLevel } from '../roles';
import { findParentSpaceId } from '../spaceChildren';

/** A Space's roles (roles.ts), kept current as it edits them. The built-ins alone with no Space. */
export function useSpaceRoles(space: Room | null | undefined): RoleLevel[] {
  const mx = useMatrixClient();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!space) return undefined;
    const onState = (event: MatrixEvent) => {
      if (event.getType() === ROLES_EVENT && event.getRoomId() === space.roomId) setVersion((v) => v + 1);
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx, space]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is what says the roles changed
  return useMemo(() => readSpaceRoles(space), [space, version]);
}

/** The roles that apply in a room: its Space's, for a channel; the built-ins for a DM. */
export function useRoomRoles(roomId: string | null | undefined): RoleLevel[] {
  const mx = useMatrixClient();
  const spaceId = roomId ? (mx.getRoom(roomId)?.isSpaceRoom() ? roomId : findParentSpaceId(mx, roomId)) : null;
  return useSpaceRoles(spaceId ? mx.getRoom(spaceId) : null);
}
