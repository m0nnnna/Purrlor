import { useEffect, useState } from 'react';
import { RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { canPostMessages, readChannelPermissions, slowmodeWaitMs, type ChannelPermissions } from '../channelPermissions';

/** A channel's permissions (matrix/channelPermissions.ts) and whether you can post, kept current
 *  as its state changes. */
export function useChannelPermissions(room: Room | null): ChannelPermissions & { canPost: boolean } {
  const mx = useMatrixClient();
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!room) return undefined;
    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() === room.roomId) setVersion((v) => v + 1);
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx, room]);

  if (!room) return { posting: 'everyone', visibility: 'space', slowmodeSeconds: 0, channelModerators: [], canPost: true };
  return { ...readChannelPermissions(room), canPost: canPostMessages(room, mx.getUserId() ?? '') };
}

/** Milliseconds until slowmode lets you post again (0 when you can), counting down live. */
export function useSlowmodeWait(room: Room | null, slowmodeSeconds: number): number {
  const mx = useMatrixClient();
  const userId = mx.getUserId() ?? '';
  const [waitMs, setWaitMs] = useState(0);

  useEffect(() => {
    if (!room || slowmodeSeconds === 0) {
      setWaitMs(0);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const next = slowmodeWaitMs(room, userId);
      setWaitMs(next);
      // Tick once a second while there's a wait, so the countdown moves and ends on its own.
      if (next > 0) timer = setTimeout(update, Math.min(1000, next));
    };
    update();
    room.on(RoomEvent.Timeline, update);
    return () => {
      clearTimeout(timer);
      room.removeListener(RoomEvent.Timeline, update);
    };
  }, [room, userId, slowmodeSeconds]);

  return waitMs;
}
