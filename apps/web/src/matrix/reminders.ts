import type { MatrixClient } from 'matrix-js-sdk';
import { readFreshAccountData } from './freshAccountData';

/**
 * "Remind me about this message", kept in account data (`xyz.nekous.reminders`) so every device
 * knows about it and the first one open when it's due shows it (ReminderWatcher.tsx), then
 * removes it for all of them. With a push gateway set up, the same reminders also reach you as Web
 * Push with no tab open (reminderPush.ts); without one, a reminder comes up when a Purrlor tab is
 * open at or after its time — late rather than never.
 *
 * Calendar events you're going to remind you too, 15 minutes before they start; those aren't
 * stored, they're worked out from your RSVPs (calendar.ts).
 */

export const REMINDERS_ACCOUNT_DATA = 'xyz.nekous.reminders';

export type MessageReminder = { id: string; roomId: string; eventId: string; remindAt: number; preview: string };

export const EVENT_REMINDER_LEAD_MS = 15 * 60 * 1000;

function isReminder(value: unknown): value is MessageReminder {
  const r = value as Partial<MessageReminder> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.roomId === 'string' &&
    typeof r.eventId === 'string' &&
    typeof r.remindAt === 'number' &&
    typeof r.preview === 'string'
  );
}

export function parseReminders(content: unknown): MessageReminder[] {
  const items = (content as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items.filter(isReminder) : [];
}

export function readReminders(mx: MatrixClient): MessageReminder[] {
  return parseReminders(mx.getAccountData(REMINDERS_ACCOUNT_DATA as any)?.getContent());
}

async function writeReminders(mx: MatrixClient, items: MessageReminder[]): Promise<void> {
  await mx.setAccountData(REMINDERS_ACCOUNT_DATA as any, { items } as any);
}

export async function addReminder(mx: MatrixClient, reminder: Omit<MessageReminder, 'id'>): Promise<void> {
  const current = parseReminders(await readFreshAccountData(mx, REMINDERS_ACCOUNT_DATA));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeReminders(mx, [...current, { ...reminder, id }]);
}

export async function removeReminder(mx: MatrixClient, id: string): Promise<void> {
  const current = parseReminders(await readFreshAccountData(mx, REMINDERS_ACCOUNT_DATA));
  if (!current.some((r) => r.id === id)) return;
  await writeReminders(mx, current.filter((r) => r.id !== id));
}

/** The choices on a message's "Remind me" menu, as times from `now`. Pure. */
export function reminderChoices(now: Date): { label: string; at: number }[] {
  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(now.getDate() + 1);
  tomorrowMorning.setHours(9, 0, 0, 0);
  return [
    { label: 'In 20 minutes', at: now.getTime() + 20 * 60 * 1000 },
    { label: 'In 1 hour', at: now.getTime() + 60 * 60 * 1000 },
    { label: 'In 3 hours', at: now.getTime() + 3 * 60 * 60 * 1000 },
    { label: 'Tomorrow at 9:00', at: tomorrowMorning.getTime() },
  ];
}

/** Which of these are due, and when the next one that isn't comes up (for the next timer). */
export function dueReminders<T extends { remindAt: number }>(items: T[], now: number): { due: T[]; nextAt: number | undefined } {
  const due = items.filter((item) => item.remindAt <= now);
  const later = items.filter((item) => item.remindAt > now).map((item) => item.remindAt);
  return { due, nextAt: later.length > 0 ? Math.min(...later) : undefined };
}
