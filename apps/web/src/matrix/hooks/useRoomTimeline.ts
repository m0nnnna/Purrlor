import { useEffect, useState } from 'react';
import { MatrixEventEvent, RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';

/**
 * Live timeline events for a room. Re-renders on new timeline events, on decryption completing
 * (encrypted events arrive as `m.room.encrypted` and get swapped to their clear type
 * asynchronously — without listening for that, decrypted messages wouldn't appear until some
 * unrelated re-render), and on a local echo's status changing (sending -> sent -> confirmed by
 * sync) — MessageTimeline.tsx disables actions that relate to an event by ID (edit/reply/pin/
 * delete/react) while it's still a local echo, since matrix-js-sdk can't target a not-yet-synced
 * event's real ID yet; without this listener the UI wouldn't unlock those the moment it's safe.
 * Also on a timeline reset: a limited ("gappy") sync swaps the room's live timeline for a fresh one
 * holding only the newest events, and the view has to follow it rather than keep the old copy.
 */
export function useRoomTimeline(roomId: string | null): MatrixEvent[] {
  const mx = useMatrixClient();
  const [events, setEvents] = useState<MatrixEvent[]>([]);

  useEffect(() => {
    if (!roomId) {
      setEvents([]);
      return undefined;
    }
    const room = mx.getRoom(roomId);
    if (!room) {
      setEvents([]);
      return undefined;
    }

    const update = () => setEvents([...room.getLiveTimeline().getEvents()]);
    update();

    const onTimeline = (_event: MatrixEvent, timelineRoom?: Room) => {
      if (timelineRoom?.roomId === roomId) update();
    };
    const onDecrypted = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId) update();
    };
    const onLocalEchoUpdated = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId) update();
    };

    const onTimelineReset = (resetRoom?: Room) => {
      if (resetRoom?.roomId === roomId) update();
    };

    mx.on(RoomEvent.Timeline, onTimeline);
    mx.on(RoomEvent.TimelineReset, onTimelineReset);
    mx.on(MatrixEventEvent.Decrypted, onDecrypted);
    mx.on(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);

    return () => {
      mx.removeListener(RoomEvent.Timeline, onTimeline);
      mx.removeListener(RoomEvent.TimelineReset, onTimelineReset);
      mx.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
      mx.removeListener(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);
    };
  }, [mx, roomId]);

  return events;
}
