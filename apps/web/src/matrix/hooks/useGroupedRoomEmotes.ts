import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { emoteLibraryAtom } from '../../app/state/emoteLibrary';
import { findParentSpaceId } from '../spaceChildren';
import { useMatrixClient } from '../MatrixClientContext';
import { getRoomEmotes, groupEmotesBySource, type Emote, type SourcedEmote } from '../emotes';

type Scoped = { space: Emote[]; channel: Emote[] };

function computeScoped(mx: ReturnType<typeof useMatrixClient>, room: Room): Scoped {
  const parentSpaceId = findParentSpaceId(mx, room.roomId);
  const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
  return { space: space ? getRoomEmotes(space) : [], channel: getRoomEmotes(room) };
}

/**
 * Same live channel-pack/parent-Space-pack subscription as useRoomEmotes.ts, but keeping the
 * global library, the Space's pack and the channel's pack separate instead of flattening them
 * into one list — for EmojiAndEmotePicker's grouped "Global / This server / Channel" display,
 * where which group an emote belongs to is the point. Everything else (composing text, rendering
 * a message) uses useRoomEmotes's plain merged list instead; this exists only for that grouping.
 */
export function useGroupedRoomEmotes(room: Room | undefined): SourcedEmote[] {
  const mx = useMatrixClient();
  const library = useAtomValue(emoteLibraryAtom).emotes;
  const [scoped, setScoped] = useState<Scoped>(() => (room ? computeScoped(mx, room) : { space: [], channel: [] }));

  useEffect(() => {
    if (!room) {
      setScoped({ space: [], channel: [] });
      return undefined;
    }

    const parentSpaceId = findParentSpaceId(mx, room.roomId);
    const space = parentSpaceId ? mx.getRoom(parentSpaceId) : undefined;
    const update = () => setScoped(computeScoped(mx, room));
    update();

    room.on(RoomStateEvent.Events, update);
    space?.on(RoomStateEvent.Events, update);
    return () => {
      room.removeListener(RoomStateEvent.Events, update);
      space?.removeListener(RoomStateEvent.Events, update);
    };
  }, [mx, room]);

  return useMemo(() => groupEmotesBySource(library, scoped.space, scoped.channel), [library, scoped]);
}
