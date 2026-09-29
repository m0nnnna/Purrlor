import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { emoteLibraryAtom } from '../../app/state/emoteLibrary';
import { findParentSpaceId } from '../spaceChildren';
import { useMatrixClient } from '../MatrixClientContext';
import { getRoomStickers, mergeByShortcode, type Sticker } from '../emotes';

/** Same channel-pack-merged-with-parent-Space-pack treatment as useRoomEmotes.ts, global library
 *  underneath — see its comment for why. */
function computeStickers(mx: ReturnType<typeof useMatrixClient>, room: Room): Sticker[] {
  const parentSpaceId = findParentSpaceId(mx, room.roomId);
  const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
  return mergeByShortcode(space ? getRoomStickers(space) : [], getRoomStickers(room));
}

export function useRoomStickers(room: Room | undefined): Sticker[] {
  const mx = useMatrixClient();
  const library = useAtomValue(emoteLibraryAtom).stickers;
  const [stickers, setStickers] = useState<Sticker[]>(() => (room ? computeStickers(mx, room) : []));

  useEffect(() => {
    if (!room) {
      setStickers([]);
      return undefined;
    }

    const parentSpaceId = findParentSpaceId(mx, room.roomId);
    const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
    const update = () => setStickers(computeStickers(mx, room));
    update();

    room.on(RoomStateEvent.Events, update);
    space?.on(RoomStateEvent.Events, update);
    return () => {
      room.removeListener(RoomStateEvent.Events, update);
      space?.removeListener(RoomStateEvent.Events, update);
    };
  }, [mx, room]);

  return useMemo(() => mergeByShortcode(library, stickers), [library, stickers]);
}
