import { useEffect, useState } from 'react';
import { EventType, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { isEncryptedRoom } from '../encryption';

/** Whether a room is end-to-end encrypted, kept current: encryption can be turned on while it's open. */
export function useRoomEncrypted(room: Room | undefined | null): boolean {
  const [encrypted, setEncrypted] = useState(() => (room ? isEncryptedRoom(room) : false));

  useEffect(() => {
    if (!room) {
      setEncrypted(false);
      return undefined;
    }
    setEncrypted(isEncryptedRoom(room));
    const onState = (event: MatrixEvent) => {
      if (event.getType() === EventType.RoomEncryption) setEncrypted(isEncryptedRoom(room));
    };
    room.on(RoomStateEvent.Events, onState);
    return () => {
      room.removeListener(RoomStateEvent.Events, onState);
    };
  }, [room]);

  return encrypted;
}
