import { useEffect, useState } from 'react';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { findParentSpaceId } from '../spaceChildren';
import { useMatrixClient } from '../MatrixClientContext';
import { getRoomEmotes, mergeByShortcode, type Emote } from '../emotes';
import { useWithLibraryEmotes } from './useEmoteLibrary';

/** A channel's own pack merged with its parent Space's — Discord's mental model is "one emoji
 *  set for the whole server," not per-channel, so a Space-wide pack (set from any channel's
 *  emote manager, see EmoteManagerModal.tsx) is available everywhere in that Space. Per-channel
 *  emotes still work (backward compatible with any pack set up before this existed) and win on a
 *  shortcode collision, being the more specific scope. The global library (emoteLibrary.ts) sits
 *  underneath both, so it's available everywhere — even with no room at all. */
function computeEmotes(mx: ReturnType<typeof useMatrixClient>, room: Room): Emote[] {
  const parentSpaceId = findParentSpaceId(mx, room.roomId);
  const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
  return mergeByShortcode(space ? getRoomEmotes(space) : [], getRoomEmotes(room));
}

export function useRoomEmotes(room: Room | undefined): Emote[] {
  const mx = useMatrixClient();
  const [emotes, setEmotes] = useState<Emote[]>(() => (room ? computeEmotes(mx, room) : []));

  useEffect(() => {
    if (!room) {
      setEmotes([]);
      return undefined;
    }

    const parentSpaceId = findParentSpaceId(mx, room.roomId);
    const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
    const update = () => setEmotes(computeEmotes(mx, room));
    update();

    room.on(RoomStateEvent.Events, update);
    space?.on(RoomStateEvent.Events, update);
    return () => {
      room.removeListener(RoomStateEvent.Events, update);
      space?.removeListener(RoomStateEvent.Events, update);
    };
  }, [mx, room]);

  return useWithLibraryEmotes(emotes);
}
