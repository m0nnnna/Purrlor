import { Direction, Method, type MatrixClient } from 'matrix-js-sdk';
import { findBlockedWord } from './automod';
import { feedJoinVia } from './feed';
import type { GuestbookWho } from './profilePage';

/**
 * **Guestbooks.** A guestbook block on a profile page (profilePage.ts) collects short messages
 * from visitors. Each entry is an `xyz.nekous.guestbook` event, `{ body }`, in the page owner's
 * profile room: world-readable, and open to anyone who has joined it (only posting is gated), so
 * signing joins the room the way liking or commenting does (postInteractions.ts). It's its own
 * event type, so nothing shows in a chat log.
 *
 * The owner's rules live on the block, and are kept in two halves, like channel moderation
 * (automod.ts, channelPermissions.ts), because Matrix can't stop an event before it's sent:
 *
 * - **Who** (`everyone`, or only people the owner follows), **slowmode** and **blocked words**:
 *   Purrlor's own form follows them, and the page leaves out entries that break them.
 * - **The owner's own client** deletes entries with a blocked word as it reads them, so they go
 *   from the room too, not just from this page. Owners remove any entry themselves the same way
 *   they remove a comment: they have power level 100 in their own profile room.
 */
export const GUESTBOOK_EVENT = 'xyz.nekous.guestbook';

export const GUESTBOOK_ENTRY_MAX = 500;
/** How many entries a page shows: the newest. */
export const GUESTBOOK_PAGE_SIZE = 50;

export type GuestbookEntry = { eventId: string; sender: string; ts: number; body: string };

export type GuestbookRules = { who: GuestbookWho; slowmode: number; blockedWords: string[] };

type RawEvent = {
  event_id?: string;
  type?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: { body?: unknown };
  unsigned?: { redacted_because?: unknown };
};

/** Entries out of raw events, in the order given. Redacted, empty and over-long ones are dropped. */
export function readGuestbookEntries(events: RawEvent[]): GuestbookEntry[] {
  const entries: GuestbookEntry[] = [];
  for (const event of events) {
    if (event.type !== GUESTBOOK_EVENT || event.unsigned?.redacted_because) continue;
    const body = typeof event.content?.body === 'string' ? event.content.body.trim() : '';
    if (!event.event_id || !event.sender || !body || body.length > GUESTBOOK_ENTRY_MAX) continue;
    entries.push({ eventId: event.event_id, sender: event.sender, ts: event.origin_server_ts ?? 0, body });
  }
  return entries;
}

/**
 * The entries a page shows: nothing that breaks the owner's rules. `ownerFollows` is who the owner
 * follows (for the "people I follow" rule); the owner's own entries always show.
 */
export function visibleGuestbookEntries(entries: GuestbookEntry[], owner: string, rules: GuestbookRules, ownerFollows: string[]): GuestbookEntry[] {
  const followed = new Set(ownerFollows);
  return entries.filter(
    (entry) =>
      (entry.sender === owner || rules.who === 'everyone' || followed.has(entry.sender)) &&
      (entry.sender === owner || !findBlockedWord(entry.body, rules.blockedWords))
  );
}

/** Whether `me` may sign right now, and why not. */
export function guestbookSigningProblem(
  me: string,
  owner: string,
  rules: GuestbookRules,
  ownerFollows: string[],
  entries: GuestbookEntry[],
  now = Date.now()
): { kind: 'following' } | { kind: 'wait'; ms: number } | undefined {
  if (me === owner) return undefined;
  if (rules.who === 'following' && !ownerFollows.includes(me)) return { kind: 'following' };
  const ms = guestbookWaitMs(entries, me, rules.slowmode, now);
  return ms > 0 ? { kind: 'wait', ms } : undefined;
}

/** How long `me` still has to wait under the slowmode: from their latest entry in what's loaded. */
export function guestbookWaitMs(entries: GuestbookEntry[], me: string, slowmodeSeconds: number, now = Date.now()): number {
  if (slowmodeSeconds <= 0) return 0;
  const last = entries.filter((entry) => entry.sender === me).reduce((latest, entry) => Math.max(latest, entry.ts), 0);
  return last ? Math.max(0, last + slowmodeSeconds * 1000 - now) : 0;
}

/** The newest entries in a profile room, newest first. Readable without joining: the room is world-readable. */
export async function fetchGuestbook(mx: MatrixClient, roomId: string): Promise<GuestbookEntry[]> {
  const res = await mx.http.authedRequest<{ chunk?: RawEvent[] }>(Method.Get, `/rooms/${encodeURIComponent(roomId)}/messages`, {
    dir: Direction.Backward,
    limit: String(GUESTBOOK_PAGE_SIZE),
    filter: JSON.stringify({ types: [GUESTBOOK_EVENT] }),
  });
  return readGuestbookEntries(res.chunk ?? []);
}

/** Signs the guestbook (joining the profile room first if needed). Throws a sentence a person can read. */
export async function signGuestbook(
  mx: MatrixClient,
  roomId: string,
  ownerId: string,
  text: string,
  rules: GuestbookRules
): Promise<void> {
  const body = text.trim();
  if (!body) throw new Error('Write something first.');
  if (body.length > GUESTBOOK_ENTRY_MAX) throw new Error(`Keep it under ${GUESTBOOK_ENTRY_MAX} characters.`);
  if (ownerId !== mx.getUserId() && findBlockedWord(body, rules.blockedWords)) {
    throw new Error('This guestbook doesn’t allow a word in that message.');
  }
  if (mx.getRoom(roomId)?.getMyMembership() !== 'join') {
    await mx.joinRoom(roomId, { viaServers: feedJoinVia(roomId, ownerId) });
  }
  await mx.sendEvent(roomId, GUESTBOOK_EVENT as any, { body } as any);
}

/** By its author, or by the page's owner (power level 100 in their own profile room). */
export async function removeGuestbookEntry(mx: MatrixClient, roomId: string, eventId: string, reason?: string): Promise<void> {
  await mx.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
}

/**
 * The owner's client deleting entries that have a blocked word, as it reads them. Returns the ids
 * it deleted (or tried to: another of the owner's devices may get there first, which is fine).
 */
export async function enforceGuestbookAutomod(mx: MatrixClient, roomId: string, entries: GuestbookEntry[], blockedWords: string[]): Promise<string[]> {
  if (blockedWords.length === 0) return [];
  const me = mx.getUserId();
  const offending = entries.filter((entry) => entry.sender !== me && findBlockedWord(entry.body, blockedWords));
  await Promise.all(
    offending.map((entry) => removeGuestbookEntry(mx, roomId, entry.eventId, 'Automod: a word this guestbook doesn’t allow').catch(() => undefined))
  );
  return offending.map((entry) => entry.eventId);
}
