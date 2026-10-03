import { useEffect, useState } from 'react';
import { EventType, RelationType, RoomEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { REACTION_SHORTCODE_FIELD } from '../reactions';

export type ReactionGroup = {
  /** The emoji itself, or — for a custom emote reaction (ReactionPicker.tsx) — the emote's own
   *  `mxc://` URL. Matrix's `m.reaction` "key" either way. */
  key: string;
  count: number;
  hasOwnReaction: boolean;
  /** This user's own reaction event ID for this key, if any — needed to redact it when toggling off. */
  ownEventId?: string;
  /** Only set when `key` is an `mxc://` URL: the shortcode carried on `com.beeper.reaction.shortcode`
   *  by whichever of this group's events set it first (reactions.ts) — for ReactionBar.tsx's
   *  tooltip/alt text. Absent if every reactor's client sent the key with no shortcode at all. */
  shortcode?: string;
  /** Who reacted with it, each once, in the order they reacted. */
  senders: string[];
};

/**
 * Live-aggregated `m.reaction` annotations for every message in a room, keyed by the target
 * message's event ID. Room-wide (one hook call per room, not per message) to match this
 * codebase's existing pattern for cross-message data — see useReadReceipts.ts,
 * usePinnedEventIds.ts. The actual aggregation is matrix-js-sdk's own `room.relations`
 * (the same mechanism Element uses), not hand-rolled here.
 */
export function useReactions(roomId: string | null): Map<string, ReactionGroup[]> {
  const mx = useMatrixClient();
  const [reactions, setReactions] = useState<Map<string, ReactionGroup[]>>(new Map());

  useEffect(() => {
    if (!roomId) {
      setReactions(new Map());
      return undefined;
    }
    const room = mx.getRoom(roomId);
    if (!room) {
      setReactions(new Map());
      return undefined;
    }

    const myUserId = mx.getUserId();

    const groupsFor = (targetEventId: string): ReactionGroup[] => {
      const relations = room.relations.getChildEventsForEvent(targetEventId, RelationType.Annotation, EventType.Reaction);
      const sorted = relations?.getSortedAnnotationsByKey() ?? [];
      return sorted
        .map(([key, events]) => {
          const live = [...events].filter((e) => !e.isRedacted());
          const own = live.find((e) => e.getSender() === myUserId);
          const shortcode = live
            .map((e) => e.getContent()[REACTION_SHORTCODE_FIELD])
            .find((s): s is string => typeof s === 'string');
          const senders = [
            ...new Set(
              [...live]
                .sort((a, b) => a.getTs() - b.getTs())
                .map((e) => e.getSender())
                .filter((s): s is string => !!s)
            ),
          ];
          return { key, count: live.length, hasOwnReaction: !!own, ownEventId: own?.getId(), shortcode, senders };
        })
        .filter((group) => group.count > 0);
    };

    const refreshTarget = (targetEventId: string | undefined) => {
      if (!targetEventId) return;
      setReactions((prev) => {
        const next = new Map(prev);
        const groups = groupsFor(targetEventId);
        if (groups.length === 0) next.delete(targetEventId);
        else next.set(targetEventId, groups);
        return next;
      });
    };

    // Seed from whatever's already loaded (initial sync, plus any earlier pagination).
    const seed = new Map<string, ReactionGroup[]>();
    for (const event of room.getLiveTimeline().getEvents()) {
      if (event.getType() !== EventType.Reaction) continue;
      const targetId = event.getRelation()?.event_id;
      if (targetId && !seed.has(targetId)) {
        const groups = groupsFor(targetId);
        if (groups.length > 0) seed.set(targetId, groups);
      }
    }
    setReactions(seed);

    const onTimeline = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId || event.getType() !== EventType.Reaction) return;
      refreshTarget(event.getRelation()?.event_id);
    };
    // A reaction we just sent is added to the timeline (and aggregated) with a temporary local
    // event ID (`~roomId:txnId`) before the server confirms it; once confirmed, the same event
    // object gets its final ID via this event, WITHOUT a fresh RoomEvent.Timeline firing. Without
    // this listener, a stored `ownEventId` stays that stale local ID forever, and redacting it
    // later (un-reacting) crashes matrix-js-sdk (`Cannot call getPendingEvents with
    // pendingEventOrdering == chronological` — it mistakes the still-`~`-prefixed id for an
    // unsent local event and tries to look it up in a pending-events store this client doesn't
    // use).
    const onLocalEcho = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId || event.getType() !== EventType.Reaction) return;
      refreshTarget(event.getRelation()?.event_id);
    };
    // A redaction's own event doesn't say what it targeted anymore, so just re-derive every
    // currently-tracked group — cheap in practice, redactions are rare relative to messages.
    const onRedaction = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId) return;
      setReactions((prev) => {
        const next = new Map<string, ReactionGroup[]>();
        for (const targetId of prev.keys()) {
          const groups = groupsFor(targetId);
          if (groups.length > 0) next.set(targetId, groups);
        }
        return next;
      });
    };

    room.on(RoomEvent.Timeline, onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    room.on(RoomEvent.Redaction, onRedaction);
    return () => {
      room.removeListener(RoomEvent.Timeline, onTimeline);
      room.removeListener(RoomEvent.LocalEchoUpdated, onLocalEcho);
      room.removeListener(RoomEvent.Redaction, onRedaction);
    };
  }, [mx, roomId]);

  return reactions;
}
