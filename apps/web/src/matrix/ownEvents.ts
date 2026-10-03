import { MatrixError, MatrixEvent, Method, type IEvent, type MatrixClient } from 'matrix-js-sdk';

/**
 * Everything you sent in a room, oldest first, read straight from the homeserver's history
 * (`/messages`, filtered to your own events), so it covers the whole room and not just what this
 * client has loaded. Encrypted events are decrypted where this session has the keys. For "Download
 * my data" (dataExport.ts) and for deleting your posts before your account goes (deleteAccount.ts).
 */

const PAGE_SIZE = 100;

export type OwnEventsOptions = {
  /** Only these event types (as sent: an encrypted room's events are `m.room.encrypted`). */
  types?: string[];
  signal?: AbortSignal;
};

export async function readOwnEvents(mx: MatrixClient, roomId: string, { types, signal }: OwnEventsOptions = {}): Promise<MatrixEvent[]> {
  const me = mx.getUserId();
  if (!me) return [];
  const filter = JSON.stringify({ senders: [me], ...(types && { types }) });
  const raw: Partial<IEvent>[] = [];
  let from: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await mx.http.authedRequest<{ chunk?: Partial<IEvent>[]; end?: string }>(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/messages`,
      { dir: 'b', limit: String(PAGE_SIZE), filter, ...(from && { from }) }
    );
    const chunk = page.chunk ?? [];
    raw.push(...chunk);
    if (!page.end || chunk.length === 0 || page.end === from) break;
    from = page.end;
  }
  const events = raw.reverse().map((event) => new MatrixEvent({ ...event, room_id: roomId }));
  for (const event of events) {
    signal?.throwIfAborted();
    if (event.isEncrypted()) await mx.decryptEventIfNeeded(event).catch(() => undefined);
  }
  return events;
}

/** Whether an event was deleted (redacted): its content is gone, so there's nothing to keep. */
export function isRedacted(event: MatrixEvent): boolean {
  return event.isRedacted() || !!event.getUnsigned()?.redacted_because;
}

/**
 * Deletes (redacts) one of your events, waiting out the homeserver's rate limit when it says to,
 * since deleting all of someone's posts is many requests in a row.
 */
export async function redactWithRetry(mx: MatrixClient, roomId: string, eventId: string, reason: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const txnId = `purrlor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await mx.http.authedRequest(
        Method.Put,
        `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
        undefined,
        { reason }
      );
      return;
    } catch (err) {
      const limited = err instanceof MatrixError && (err.errcode === 'M_LIMIT_EXCEEDED' || err.httpStatus === 429);
      if (!limited || attempt >= 8) throw err;
      const wait = Math.min(Math.max(Number(err.data?.retry_after_ms) || 1000 * 2 ** attempt, 200), 30_000);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
