/**
 * The pure parts of the admin control channel (controlServer.ts has the socket, adminRoom.ts the
 * homeserver side): reading what an admin typed, the audit log's lines, the deletion queue, and
 * the report notices the homeserver posts in its admin room. Unit-tested in control.test.ts.
 */
import { isMxc } from './publicWeb.js';

// --- What an admin typed ------------------------------------------------------------------------

/**
 * A file named the ways an admin is likely to have it: `mxc://server/id`, the public media link
 * from a complaint (`https://purr.example/api/public/media/server/id?width=…`), or a homeserver
 * download or thumbnail link. Undefined for anything else.
 */
export function parseMediaTarget(input: string): string | undefined {
  const text = input.trim();
  if (isMxc(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const match = /^\/(?:api\/public\/media|_matrix\/(?:client\/v1\/media|media\/v3|media\/r0)\/(?:download|thumbnail))\/([^/]+)\/([^/]+)(?:\/[^/]*)?$/.exec(url.pathname);
  if (!match) return undefined;
  let mxc: string;
  try {
    mxc = `mxc://${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  } catch {
    return undefined;
  }
  return isMxc(mxc) ? mxc : undefined;
}

/** The sudo user who ran a command, as the audit log names them; `root` when there isn't a sensible one. */
export function cleanActor(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(value) ? value : 'root';
}

/** A reason as one line of at most 500 characters; empty when none was given. */
export function cleanReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return [...value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 500).join('');
}

/**
 * Text that's safe to print on an admin's terminal: no control characters but newline and tab, no
 * C1 controls, and no bidirectional overrides. Replies carry things other people wrote (an album's
 * title on someone's page, a homeserver's error), and an escape sequence in one could otherwise
 * rewrite what the admin sees, retitle the window, or (in some terminals) write to the clipboard.
 */
export function terminalSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

// --- The block list file ------------------------------------------------------------------------

/** blocked-media.txt: one mxc:// URL per line; blank lines and `#` comments ignored. */
export function parseMediaList(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(isMxc)
  );
}

// --- The audit log ------------------------------------------------------------------------------

export type AuditEntry = {
  /** ISO time. */
  at: string;
  /** The sudo user (`SUDO_USER`), or root. */
  actor: string;
  /** What was done: `pages.hide`, `takedown.media`, `deletions.run`… */
  action: string;
  /** Who or what it was done to. */
  target?: string;
  reason?: string;
  /** `ok`, or what went wrong. */
  result: string;
};

/**
 * One line of the audit log: JSON, so nothing in a reason or a target can start a line of its
 * own or pass for another entry.
 */
export function auditLine(entry: AuditEntry): string {
  const clean = (value: string | undefined, max: number) => (value === undefined ? undefined : cleanReason(value).slice(0, max));
  return `${JSON.stringify({
    at: entry.at,
    actor: cleanActor(entry.actor),
    action: clean(entry.action, 64),
    ...(entry.target !== undefined && { target: clean(entry.target, 2000) }),
    ...(entry.reason && { reason: clean(entry.reason, 500) }),
    result: clean(entry.result, 500),
  })}\n`;
}

// --- The deletion queue -------------------------------------------------------------------------

/**
 * A file queued for deletion from the homeserver by a takedown. It's blocked on the public media
 * route as soon as it's queued; deleting the original needs the homeserver's admin, so it waits
 * for `purrlor takedown delete` (which asks for the admin's password) and records how that went.
 */
export type DeletionEntry = {
  mxc: string;
  queuedAt: string;
  actor: string;
  reason: string;
  status: 'queued' | 'deleted' | 'failed';
  /** When it was deleted, or last tried. */
  doneAt?: string;
  /** The homeserver's answer when it failed. */
  note?: string;
};

export function parseDeletions(text: string): DeletionEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DeletionEntry[] => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    if (!isMxc(entry.mxc) || !['queued', 'deleted', 'failed'].includes(entry.status as string)) return [];
    return [
      {
        mxc: entry.mxc,
        queuedAt: typeof entry.queuedAt === 'string' ? entry.queuedAt : '',
        actor: cleanActor(entry.actor),
        reason: cleanReason(entry.reason),
        status: entry.status as DeletionEntry['status'],
        ...(typeof entry.doneAt === 'string' && { doneAt: entry.doneAt }),
        ...(typeof entry.note === 'string' && { note: cleanReason(entry.note) }),
      },
    ];
  });
}

/** Queues files not already queued or deleted; a failed one goes back in the queue. */
export function queueDeletions(entries: DeletionEntry[], mxcs: string[], actor: string, reason: string, now: string): { entries: DeletionEntry[]; result: string[] } {
  const next = [...entries];
  const queued: string[] = [];
  for (const mxc of mxcs) {
    const existing = next.findIndex((entry) => entry.mxc === mxc);
    if (existing >= 0 && next[existing].status !== 'failed') continue;
    const entry: DeletionEntry = { mxc, queuedAt: now, actor, reason, status: 'queued' };
    if (existing >= 0) next[existing] = entry;
    else next.push(entry);
    queued.push(mxc);
  }
  return { entries: next, result: queued };
}

/** What the homeserver's `media delete` answer means. */
export function deletionSucceeded(reply: string): boolean {
  return /^Deleted the MXC/i.test(reply.trim());
}

// --- Reports, from the homeserver's admin room --------------------------------------------------

// Room version 12 room IDs have no server part (`!<hash>`); older ones do (`!opaque:server`).
const ROOM_ID = /^![A-Za-z0-9._~=+/-]{1,255}(:[A-Za-z0-9.\-:[\]]{1,255})?$/;
const EVENT_ID = /^\$[A-Za-z0-9_\-+/=:.]{1,255}$/;
const USER_ID = /^@[a-z0-9._=\-/+]{1,255}:[A-Za-z0-9.\-:[\]]{1,255}$/;

export type Report = {
  /** The admin room notice's own event ID. */
  noticeId: string;
  ts: number;
  kind: 'event' | 'room' | 'user';
  reporter: string;
  roomId?: string;
  eventId?: string;
  userId?: string;
  reason: string;
};

/**
 * A report, from the notice Continuwuity posts in its admin room when someone uses Matrix's
 * report API:
 *
 *   @room New event report received from @nibbles:purr.example:
 *
 *   - Reported Room ID: `!room:purr.example`
 *   - Reported Event ID: `$event`
 *   - Report Reason: whatever they typed
 *
 * Only notices the server itself sent count (`@conduit:<server>`), since anyone in the admin room
 * can post text that looks like one. The reason is last and is the reporter's own words, newlines
 * included, so the IDs are read only from the part before it: a reason can't pass for another ID.
 */
export function parseReportNotice(
  event: { event_id?: string; sender?: string; origin_server_ts?: number; type?: string; content?: Record<string, unknown> },
  serverName: string
): Report | undefined {
  if (event.type !== 'm.room.message' || event.sender !== `@conduit:${serverName}` || !event.event_id) return undefined;
  const body = event.content?.body;
  if (typeof body !== 'string') return undefined;
  const head = /^@room New (event|room|user) report received from (@\S+):\n/.exec(body);
  if (!head || !USER_ID.test(head[2])) return undefined;
  const reasonAt = body.indexOf('\n- Report Reason: ');
  const fields = reasonAt >= 0 ? body.slice(0, reasonAt) : body;
  const reason = reasonAt >= 0 ? body.slice(reasonAt + '\n- Report Reason: '.length).trim() : '';
  const field = (name: string, pattern: RegExp) => {
    const value = new RegExp(`\\n- Reported ${name}: \`([^\`\\n]+)\``).exec(fields)?.[1];
    return value && pattern.test(value) ? value : undefined;
  };
  const roomId = field('Room ID', ROOM_ID);
  const eventId = field('Event ID', EVENT_ID);
  const userId = field('User ID', USER_ID);
  return {
    noticeId: event.event_id,
    ts: event.origin_server_ts ?? 0,
    kind: head[1] as Report['kind'],
    reporter: head[2],
    ...(roomId && { roomId }),
    ...(eventId && { eventId }),
    ...(userId && { userId }),
    reason: [...reason].slice(0, 2000).join(''),
  };
}
