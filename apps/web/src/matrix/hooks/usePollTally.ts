import { useEffect, useState } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { fetchPollRelations, isPollEndEvent, isPollResponseEvent, parsePollEnd, parsePollResponse, parsePollStart } from '../polls';
import { tallyPoll, type PollDefinition, type PollResponseInput, type PollTally } from '../pollTally';

export type PollState = { definition: PollDefinition; tally: PollTally };

/**
 * Live poll results for a single `m.poll.start` event: its `m.poll.response`/`m.poll.end` events
 * (both hidden from the rendered timeline itself — see MessageTimeline.tsx's `messages` filter),
 * fed through the pure `tallyPoll`. They come from two places, merged by event id: the server's
 * `/relations` for the poll, fetched once when it's shown, which has every vote however long ago
 * it was cast; and the loaded timeline, which brings new votes as they arrive.
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

    // From /relations: every vote the server has, including ones from long before this session.
    let fetched: MatrixEvent[] = [];
    let cancelled = false;

    const compute = () => {
      const responses: PollResponseInput[] = [];
      let endTs: number | null = null;
      // The same vote can be both fetched and in the timeline; the timeline's copy wins, as it's
      // the one redactions and local echoes update.
      const byId = new Map<string, MatrixEvent>();
      for (const event of fetched) byId.set(event.getId() ?? '', event);
      for (const event of room.getLiveTimeline().getEvents()) byId.set(event.getId() ?? '', event);
      for (const event of byId.values()) {
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
    fetchPollRelations(mx, room.roomId, startEventId)
      .then((events) => {
        if (cancelled) return;
        fetched = events;
        compute();
      })
      .catch((err: unknown) => console.warn('Couldn’t load the poll’s earlier votes', err));

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
      cancelled = true;
      room.removeListener(RoomEvent.Timeline, onTimeline);
      room.removeListener(RoomEvent.LocalEchoUpdated, onLocalEcho);
      room.removeListener(RoomEvent.Redaction, onRedaction);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, room, startEventId]);

  return state;
}
