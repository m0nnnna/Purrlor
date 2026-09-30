import type { MatrixClient } from 'matrix-js-sdk';
import { readCalendarEvents, readOwnRsvp, type CalendarEvent } from './calendar';
import { isEncryptedRoom } from './encryption';
import { getOpenIdTokenCached } from './openIdToken';
import { readPushGatewayUrl } from './push';
import { EVENT_REMINDER_LEAD_MS, readReminders, type MessageReminder } from './reminders';

/**
 * Hands your reminders to the push gateway, which fires them as Web Push when they're due — so a
 * reminder reaches you with no Purrlor tab open (services/push-gateway/src/reminders.ts,
 * docs/push-notifications.md). The whole list goes each time and replaces the last, so a reminder
 * cancelled, or already shown on some device (which removes it from account data), drops out.
 *
 * Each reminder's id is the tag ReminderWatcher shows it under in a tab, so when both show it the
 * browser replaces one notification with the other instead of showing it twice.
 */

export type GatewayReminder = { id: string; at: number; title: string; body: string; roomId?: string; eventId?: string };

const GENERIC_BODY = 'A message you asked to be reminded about';

/**
 * The list to send, from your message reminders and the events you're going to. A message in an
 * encrypted room keeps its words off the gateway: the reminder says only that it's due. Pure.
 *
 * Only what's still ahead goes. The gateway forgets a reminder once it has fired, but a message
 * reminder stays in account data until a tab shows it, and an event's is worked out afresh; sent
 * again once due, either would fire a second time. Anything already due is this open tab's to show.
 */
export function remindersForGateway(
  messages: MessageReminder[],
  events: CalendarEvent[],
  { now, encryptedRoomIds }: { now: number; encryptedRoomIds: Set<string> }
): GatewayReminder[] {
  const fromMessages = messages.map((r) => ({
    id: `message:${r.id}`,
    at: r.remindAt,
    title: 'Reminder',
    body: encryptedRoomIds.has(r.roomId) ? GENERIC_BODY : r.preview || GENERIC_BODY,
    roomId: r.roomId,
    eventId: r.eventId,
  }));
  const fromEvents = events.map((event) => ({
    id: `event:${event.id}`,
    at: event.start - EVENT_REMINDER_LEAD_MS,
    title: event.title,
    body: `Starts at ${new Date(event.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
  }));
  return [...fromMessages, ...fromEvents].filter((r) => r.at > now).sort((a, b) => a.at - b.at);
}

/** Sends this account's reminders to its push gateway. Nothing to do without one. */
export async function syncRemindersToGateway(mx: MatrixClient, now = Date.now()): Promise<void> {
  const gatewayUrl = readPushGatewayUrl(mx);
  const myUserId = mx.getUserId();
  if (!gatewayUrl || !myUserId) return;

  const messages = readReminders(mx);
  const encryptedRoomIds = new Set(
    messages.flatMap((r) => {
      const room = mx.getRoom(r.roomId);
      // A room this client can't see is treated as encrypted: no words leave it.
      return !room || isEncryptedRoom(room) ? [r.roomId] : [];
    })
  );
  const going = mx
    .getRooms()
    .filter((room) => room.isSpaceRoom() && room.getMyMembership() === 'join')
    .flatMap((space) => readCalendarEvents(space).filter((event) => readOwnRsvp(space, myUserId, event.id) === 'going'));

  const reminders = remindersForGateway(messages, going, { now, encryptedRoomIds });
  const openIdToken = await getOpenIdTokenCached(mx);
  const res = await fetch(`${gatewayUrl}/reminders`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: openIdToken, reminders }),
  });
  if (!res.ok) throw new Error(`Push gateway refused reminders (${res.status})`);
}
