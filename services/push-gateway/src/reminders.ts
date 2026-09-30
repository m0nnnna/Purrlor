import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Reminders this gateway fires as Web Push when they're due, so a reminder reaches you with no
 * Purrlor tab open (docs/push-notifications.md, "Reminders"). Matrix has no server-side
 * scheduling a client can rely on, and this service already holds each account's browsers.
 *
 * A client hands over its account's whole list (PUT /reminders, with an OpenID token): message
 * reminders from account data, and calendar events it's going to. The list replaces whatever that
 * account had, so a reminder cancelled or already shown on another device just drops out of the
 * next one sent. Kept in memory, and in REMINDERS_FILE when it's set, so a restart doesn't lose
 * the reminders of people who won't open the app before they're due.
 */

export type Reminder = {
  /** The client's own id, also the notification's tag: a tab showing it too replaces, not doubles. */
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  title: string;
  body: string;
  roomId?: string;
  eventId?: string;
};

/** Per account. Past this, the soonest are kept. */
export const MAX_REMINDERS = 100;
const MAX_TEXT = 200;
/** Later than this isn't a reminder anyone's waiting on this gateway for. */
const MAX_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;

const byOwner = new Map<string, Reminder[]>();
let file: string | undefined;

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback);
const optionalId = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : undefined);

/** A client's list, checked and trimmed: anything malformed or out of range is dropped. Pure. */
export function parseReminders(value: unknown, now = Date.now()): Reminder[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const valid: Reminder[] = [];
  for (const item of value) {
    const r = item as Record<string, unknown> | null;
    const id = optionalId(r?.id);
    const at = r?.at;
    if (!r || !id || seen.has(id) || typeof at !== 'number' || !Number.isFinite(at) || at > now + MAX_AHEAD_MS) continue;
    seen.add(id);
    valid.push({ id, at, title: text(r.title, 'Reminder'), body: text(r.body), roomId: optionalId(r.roomId), eventId: optionalId(r.eventId) });
  }
  return valid.sort((a, b) => a.at - b.at).slice(0, MAX_REMINDERS);
}

function save(): void {
  if (!file) return;
  try {
    // Written aside, then moved over: a crash mid-write can't leave half a file behind.
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(byOwner)));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error('Couldn’t save reminders', err);
  }
}

/** Where reminders are kept across restarts, and what was kept there last time. */
export function loadReminders(path: string | undefined): void {
  file = path;
  byOwner.clear();
  if (!path) return;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const [owner, list] of Object.entries(stored)) {
      // Past-due ones stay: they fire on the first sweep, late rather than never.
      const reminders = parseReminders(list, Date.now());
      if (reminders.length > 0) byOwner.set(owner, reminders);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.error('Couldn’t read saved reminders', err);
  }
}

/** Replaces an account's reminders with this list. */
export function setReminders(owner: string, reminders: Reminder[]): void {
  if (reminders.length === 0) byOwner.delete(owner);
  else byOwner.set(owner, reminders);
  save();
}

export function remindersOf(owner: string): Reminder[] {
  return byOwner.get(owner) ?? [];
}

/** Takes every reminder that's due out of the store, with whose it is. */
export function takeDue(now = Date.now()): { owner: string; reminder: Reminder }[] {
  const due: { owner: string; reminder: Reminder }[] = [];
  for (const [owner, list] of byOwner) {
    const later = list.filter((reminder) => {
      if (reminder.at > now) return true;
      due.push({ owner, reminder });
      return false;
    });
    if (later.length === 0) byOwner.delete(owner);
    else byOwner.set(owner, later);
  }
  if (due.length > 0) save();
  return due;
}
