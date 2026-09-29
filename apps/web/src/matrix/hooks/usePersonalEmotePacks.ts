import { useEffect, useState } from 'react';
import { ClientEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { EMOTE_ROOMS_EVENT, readPersonalEmotePacks, USER_EMOTES_EVENT, type PersonalPack } from '../personalEmotePacks';

/**
 * Live view of personalEmotePacks.ts: your own pack plus every room pack you've subscribed to.
 * Recomputes when either account data event changes, when a subscribed room newly arrives (you'd
 * named it in `im.ponies.emote_rooms` before it had synced), and on a state change in any
 * currently-subscribed room (its pack being edited by whoever owns it).
 */
export function usePersonalEmotePacks(): PersonalPack[] {
  const mx = useMatrixClient();
  const [packs, setPacks] = useState<PersonalPack[]>(() => readPersonalEmotePacks(mx));

  useEffect(() => {
    const update = () => setPacks(readPersonalEmotePacks(mx));
    update();

    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === USER_EMOTES_EVENT || event.getType() === EMOTE_ROOMS_EVENT) update();
    };

    const subscribedRoomIds = Object.keys(
      mx.getAccountData(EMOTE_ROOMS_EVENT as any)?.getContent<{ rooms?: Record<string, unknown> }>()?.rooms ?? {}
    );
    const watchedRooms: Room[] = [];
    for (const roomId of subscribedRoomIds) {
      const room = mx.getRoom(roomId);
      if (!room) continue;
      room.on(RoomStateEvent.Events, update);
      watchedRooms.push(room);
    }

    mx.on(ClientEvent.AccountData, onAccountData);
    mx.on(ClientEvent.Room, update);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
      mx.removeListener(ClientEvent.Room, update);
      for (const room of watchedRooms) room.removeListener(RoomStateEvent.Events, update);
    };
  }, [mx]);

  return packs;
}
