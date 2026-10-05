import { MsgType, RelationType, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';

/**
 * Sends an `m.replace` edit for one of your own messages. matrix-js-sdk (and every other
 * Matrix client) aggregates this onto the original event automatically — see
 * MessageTimeline.tsx's use of `event.getContent()`/`event.replacingEvent()`, no separate read
 * path needed. `body` carries the classic `* <text>` fallback for clients that don't render
 * edits, per the spec's own convention.
 */
export async function editMessage(
  mx: MatrixClient,
  roomId: string,
  eventId: string,
  newBody: string,
  /** More of the new content: its link embeds (matrix/embeds.ts), which an edit restates whole. */
  extra: Record<string, unknown> = {}
): Promise<void> {
  await mx.sendMessage(roomId, null, {
    msgtype: MsgType.Text,
    body: `* ${newBody}`,
    'm.new_content': { msgtype: MsgType.Text, body: newBody, ...extra },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: eventId },
  });
}

export type EditHistoryEntry = { body: string; ts: number; isOriginal: boolean };

/**
 * Every version of a message, oldest first, including the original — a direct `/relations`
 * fetch (not the locally-aggregated `event.replacingEvent()`, which only ever holds the latest
 * one) so this is complete even for an edit made before the current session paginated back that
 * far in the timeline.
 */
export async function fetchEditHistory(mx: MatrixClient, roomId: string, event: MatrixEvent): Promise<EditHistoryEntry[]> {
  const eventId = event.getId();
  if (!eventId) return [];
  const { events } = await mx.relations(roomId, eventId, RelationType.Replace, 'm.room.message');
  const edits = events
    .map((edit) => ({
      body: String(edit.getContent()['m.new_content']?.body ?? edit.getContent().body ?? ''),
      ts: edit.getTs(),
      isOriginal: false,
    }))
    .sort((a, b) => a.ts - b.ts);
  const original: EditHistoryEntry = {
    body: String(event.getOriginalContent().body ?? ''),
    ts: event.getTs(),
    isOriginal: true,
  };
  return [original, ...edits];
}
