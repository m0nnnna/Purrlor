import { useEffect, useState } from 'react';
import { ThreadEvent, type MatrixEvent, type Room, type Thread } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';

export type ThreadSummary = {
  rootEventId: string;
  replyCount: number;
  lastReplySenderName?: string;
  lastReplyTs?: number;
};

function summarize(thread: Thread): ThreadSummary {
  const last = thread.replyToEvent;
  return {
    rootEventId: thread.id,
    replyCount: thread.length,
    lastReplySenderName: last?.sender?.name ?? last?.getSender(),
    lastReplyTs: last?.getTs(),
  };
}

/**
 * Live thread summaries for a room, keyed by the thread's root event ID (the message it's
 * attached to in the main timeline). Thread aggregation and reply tracking is matrix-js-sdk's
 * own `Thread` model (`room.getThreads()`, `ThreadEvent`) — the same mechanism Element uses —
 * this hook just mirrors it into React state, matching this codebase's existing pattern for
 * cross-message room data (see useReactions.ts, useReadReceipts.ts).
 */
export function useThreads(roomId: string | null): Map<string, ThreadSummary> {
  const mx = useMatrixClient();
  const [threads, setThreads] = useState<Map<string, ThreadSummary>>(new Map());

  useEffect(() => {
    if (!roomId) {
      setThreads(new Map());
      return undefined;
    }
    const room = mx.getRoom(roomId);
    if (!room) {
      setThreads(new Map());
      return undefined;
    }

    const recompute = () => {
      const next = new Map<string, ThreadSummary>();
      for (const thread of room.getThreads()) {
        // One opened in the thread panel but not replied to yet (useThreadEvents) isn't a thread to show.
        if (thread.length > 0) next.set(thread.id, summarize(thread));
      }
      setThreads(next);
    };

    recompute();

    // Every thread already known (from initial sync) needs its own update listeners wired —
    // ThreadEvent.New only fires for threads that appear *after* this hook mounts.
    for (const thread of room.getThreads()) {
      thread.on(ThreadEvent.Update, recompute);
      thread.on(ThreadEvent.NewReply, recompute);
    }

    const onThreadNew = (thread: Thread) => {
      thread.on(ThreadEvent.Update, recompute);
      thread.on(ThreadEvent.NewReply, recompute);
      recompute();
    };
    room.on(ThreadEvent.New, onThreadNew);

    return () => {
      room.removeListener(ThreadEvent.New, onThreadNew);
      for (const thread of room.getThreads()) {
        thread.removeListener(ThreadEvent.Update, recompute);
        thread.removeListener(ThreadEvent.NewReply, recompute);
      }
    };
  }, [mx, roomId]);

  return threads;
}

/**
 * Live event list for one thread, by its root event ID. Handles the "no thread yet" case (a
 * message with no replies) by returning an empty list and lazily attaching once a matching
 * thread is actually created — e.g. right after sending the first reply through this same
 * panel — rather than requiring the caller to already know a Thread object exists.
 *
 * A root with no thread yet gets an empty one here, as Element's thread view does. Without it the
 * SDK has nowhere to put the first reply: its local echo belongs to no timeline, and the server's
 * copy is then taken for that echo's return and skipped, so the reply never shows (nor does the
 * thread) until a reload.
 */
export function useThreadEvents(room: Room | undefined, rootEventId: string | null): MatrixEvent[] {
  const [events, setEvents] = useState<MatrixEvent[]>([]);

  useEffect(() => {
    if (!room || !rootEventId) {
      setEvents([]);
      return undefined;
    }

    const rootEvent = room.findEventById(rootEventId);
    let thread = room.getThread(rootEventId) ?? (rootEvent ? room.createThread(rootEventId, rootEvent, [], true) : undefined);
    const update = () => setEvents(thread ? [...thread.events] : []);

    const attach = (t: Thread) => {
      thread = t;
      thread.on(ThreadEvent.Update, update);
      thread.on(ThreadEvent.NewReply, update);
      update();
    };

    if (thread) attach(thread);
    else update();

    const onThreadNew = (newThread: Thread) => {
      if (newThread.id === rootEventId && !thread) attach(newThread);
    };
    room.on(ThreadEvent.New, onThreadNew);

    return () => {
      room.removeListener(ThreadEvent.New, onThreadNew);
      if (thread) {
        thread.removeListener(ThreadEvent.Update, update);
        thread.removeListener(ThreadEvent.NewReply, update);
      }
    };
  }, [room, rootEventId]);

  return events;
}
