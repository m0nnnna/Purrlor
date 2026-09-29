import { useEffect, useState } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { isPollEndEvent, isPollResponseEvent, parsePollEnd, parsePollResponse, parsePollStart } from '../polls';
import { tallyPoll, type PollDefinition, type PollResponseInput, type PollTally } from '../pollTally';

export type PollState = { definition: PollDefinition; tally: PollTally };

/**
 * Live poll results for a single `m.poll.start` event. Scans the room's currently-loaded
 * timeline for its `m.poll.response`/`m.poll.end` events (both hidden from the rendered timeline
 * itself — see MessageTimeline.tsx's `messages` filter) and feeds them through the pure
 * `tallyPoll`, the same "aggregate matrix-js-sdk's own timeline, not a hand-rolled event log"
 * approach useReactions.ts uses for `m.reaction`. Like that hook, this only sees responses that
 * have actually been loaded into the live timeline — a poll whose votes are further back than
 * this session has paginated won't have them counted until scrollback reaches them.
 */
export function usePollTally(room: Room | undefined, startEvent: MatrixEvent): PollState | null {
  const mx = useMatrixClient();
  const startEventId = startEvent.getId();
  const [state, setState] = useState<PollState | null>(null);

  useEffect(() => {
    if (!room || !startEventId) {
      setState(null);
      return undefined;
    }
    const definition = parsePollStart(startEvent);
    if (!definition) {
      setState(null);
      return undefined;
    }

    const compute = () => {
      const responses: PollResponseInput[] = [];
      let endTs: number | null = null;
      for (const event of room.getLiveTimeline().getEvents()) {
        if (event.isRedacted()) continue;
        if (isPollResponseEvent(event)) {
          const parsed = parsePollResponse(event);
          const senderId = event.getSender();
          if (parsed && senderId && parsed.pollEventId === startEventId) {
            responses.push({ senderId, ts: event.getTs(), answerIds: parsed.answerIds });
          }
        } else if (isPollEndEvent(event)) {
          const parsed = parsePollEnd(event);
          // First close wins if more than one m.poll.end somehow shows up for the same poll.
          if (parsed && parsed.pollEventId === startEventId && (endTs === null || event.getTs() < endTs)) {
            endTs = event.getTs();
          }
        }
      }
      setState({ definition, tally: tallyPoll({ definition, responses, endTs, myUserId: mx.getUserId() }) });
    };

    compute();

    const onTimeline = (event: MatrixEvent, timelineRoom?: Room) => {
      if (timelineRoom?.roomId !== room.roomId) return;
      if (isPollResponseEvent(event) || isPollEndEvent(event)) compute();
    };
    const onLocalEcho = (event: MatrixEvent) => {
      if (event.getRoomId() !== room.roomId) return;
      if (isPollResponseEvent(event) || isPollEndEvent(event)) compute();
    };
    // A redaction event doesn't say what it targeted by type — cheap enough to just recompute,
    // same tradeoff useReactions.ts makes for the same reason.
    const onRedaction = (event: MatrixEvent) => {
      if (event.getRoomId() !== room.roomId) return;
      compute();
    };

    room.on(RoomEvent.Timeline, onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    room.on(RoomEvent.Redaction, onRedaction);
    return () => {
      room.removeListener(RoomEvent.Timeline, onTimeline);
      room.removeListener(RoomEvent.LocalEchoUpdated, onLocalEcho);
      room.removeListener(RoomEvent.Redaction, onRedaction);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, room, startEventId]);

  return state;
}
