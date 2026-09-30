import { useEffect, useRef, useState } from 'react';
import { ClientEvent, RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';

/** A burst of events (a sync catching up, a big Space's members loading) is one recompute. */
const BATCH_MS = 50;

/** What a list looks like to its readers: which rooms, in what order, under what names. */
function signature(rooms: Room[]): string {
  return rooms.map((room) => `${room.roomId}\u0000${room.name}`).join('\u0001');
}

/**
 * A list of rooms worked out from the whole client (the DM list, a Space's channels, invites,
 * Spaces), kept current the cheap way. Lists like these used to be rebuilt, and their component
 * re-rendered with a new array, on every state event in every room — thousands during a sync on a
 * big account, each one scanning every room. This recomputes only for events that can change the
 * list (`isRelevant`), once per burst, and hands back a new array only when the rooms, their order
 * or their names actually changed.
 *
 * Rooms appearing and disappearing, and your own membership changing, always count. `timeline`
 * also counts new messages, for a list ordered by recent activity.
 */
export function useRoomList(
  compute: () => Room[],
  deps: unknown[],
  { isRelevant = () => false, timeline = false }: { isRelevant?: (event: MatrixEvent) => boolean; timeline?: boolean } = {}
): Room[] {
  const mx = useMatrixClient();
  const [rooms, setRooms] = useState<Room[]>(compute);
  const signatureRef = useRef(signature(rooms));
  // The latest of each, so the listeners below needn't be re-attached every render.
  const computeRef = useRef(compute);
  const isRelevantRef = useRef(isRelevant);
  computeRef.current = compute;
  isRelevantRef.current = isRelevant;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recompute = () => {
      timer = undefined;
      const next = computeRef.current();
      const nextSignature = signature(next);
      if (nextSignature === signatureRef.current) return;
      signatureRef.current = nextSignature;
      setRooms(next);
    };
    const soon = () => {
      if (timer === undefined) timer = setTimeout(recompute, BATCH_MS);
    };
    const onState = (event: MatrixEvent) => {
      if (isRelevantRef.current(event)) soon();
    };
    const onTimeline = (_event: MatrixEvent, _room: Room | undefined, toStart: boolean | undefined) => {
      if (!toStart) soon();
    };

    recompute(); // the deps changed: the list may have too
    mx.on(ClientEvent.Room, soon);
    mx.on(ClientEvent.DeleteRoom, soon);
    mx.on(RoomEvent.MyMembership, soon);
    mx.on(RoomEvent.Name, soon);
    mx.on(RoomStateEvent.Events, onState);
    if (timeline) mx.on(RoomEvent.Timeline, onTimeline);
    return () => {
      clearTimeout(timer);
      mx.removeListener(ClientEvent.Room, soon);
      mx.removeListener(ClientEvent.DeleteRoom, soon);
      mx.removeListener(RoomEvent.MyMembership, soon);
      mx.removeListener(RoomEvent.Name, soon);
      mx.removeListener(RoomStateEvent.Events, onState);
      if (timeline) mx.removeListener(RoomEvent.Timeline, onTimeline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` are the caller's inputs to `compute`
  }, [mx, timeline, ...deps]);

  return rooms;
}
