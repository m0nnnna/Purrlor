import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';

/**
 * A Space's calendar: events its members can see coming up and RSVP to. docs/calendar.md has the
 * design. In short:
 *
 * - **Events** are state in the Space: `xyz.nekous.calendar_event`, one per event, state key = the
 *   event's id. Space state is what every member can read (and a public Space shows to anyone),
 *   and state events need the Space's state level to write — moderators, by default — so members
 *   can't fill the calendar or edit someone else's event. Cancelling empties the content.
 * - **RSVPs** live in each member's own `m.room.member` event in the Space, under
 *   `xyz.nekous.rsvps`. It's the one piece of Space state every member can write for themselves
 *   and nobody else can (the same trick `xyz.nekous.feed_room` uses, see feed.ts), so there's no
 *   power level to open up and nobody can RSVP for someone else.
 */

export const CALENDAR_EVENT = 'xyz.nekous.calendar_event';
export const RSVPS_KEY = 'xyz.nekous.rsvps';

export type Rsvp = 'going' | 'interested';

export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  /** Milliseconds since the epoch, UTC. */
  start: number;
  end?: number;
  /** A channel of the Space it happens in (a voice channel, say), if any. */
  channelId?: string;
  /** Free text, for somewhere that isn't a channel. */
  location?: string;
  createdBy: string;
};

type CalendarContent = {
  title?: unknown;
  description?: unknown;
  start?: unknown;
  end?: unknown;
  channel_id?: unknown;
  location?: unknown;
};

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;

/** Reads one event's content, or undefined for a cancelled or malformed one. Pure. */
export function parseCalendarEvent(id: string, sender: string, content: CalendarContent): CalendarEvent | undefined {
  if (typeof content.title !== 'string' || !content.title.trim()) return undefined;
  if (typeof content.start !== 'number' || !Number.isFinite(content.start)) return undefined;
  const end = typeof content.end === 'number' && Number.isFinite(content.end) && content.end > content.start ? content.end : undefined;
  return {
    id,
    title: content.title.slice(0, MAX_TITLE),
    description: typeof content.description === 'string' ? content.description.slice(0, MAX_DESCRIPTION) : '',
    start: content.start,
    end,
    channelId: typeof content.channel_id === 'string' ? content.channel_id : undefined,
    location: typeof content.location === 'string' && content.location.trim() ? content.location : undefined,
    createdBy: sender,
  };
}

export function readCalendarEvents(space: Room): CalendarEvent[] {
  return (space.currentState.getStateEvents(CALENDAR_EVENT) as MatrixEvent[])
    .flatMap((event) => parseCalendarEvent(event.getStateKey() ?? '', event.getSender() ?? '', event.getContent()) ?? [])
    .sort((a, b) => a.start - b.start);
}

/** Events that haven't finished yet, soonest first. An event with no end counts as an hour. */
export function upcomingEvents(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  return events.filter((event) => (event.end ?? event.start + 60 * 60 * 1000) > now);
}

export function pastEvents(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  return events.filter((event) => (event.end ?? event.start + 60 * 60 * 1000) <= now).reverse();
}

export function canManageCalendar(space: Room, userId: string): boolean {
  return space.currentState.maySendStateEvent(CALENDAR_EVENT, userId);
}

function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export type CalendarEventInput = Omit<CalendarEvent, 'id' | 'createdBy'>;

function toContent(input: CalendarEventInput): Record<string, unknown> {
  return {
    title: input.title.trim().slice(0, MAX_TITLE),
    description: input.description.trim().slice(0, MAX_DESCRIPTION),
    start: input.start,
    ...(input.end && input.end > input.start && { end: input.end }),
    ...(input.channelId && { channel_id: input.channelId }),
    ...(input.location?.trim() && { location: input.location.trim() }),
  };
}

export async function createCalendarEvent(mx: MatrixClient, space: Room, input: CalendarEventInput): Promise<string> {
  const id = newEventId();
  await mx.sendStateEvent(space.roomId, CALENDAR_EVENT as any, toContent(input) as any, id);
  return id;
}

export async function updateCalendarEvent(mx: MatrixClient, space: Room, id: string, input: CalendarEventInput): Promise<void> {
  await mx.sendStateEvent(space.roomId, CALENDAR_EVENT as any, toContent(input) as any, id);
}

/** Empty content is how Matrix state says "gone"; readCalendarEvents skips it. */
export async function cancelCalendarEvent(mx: MatrixClient, space: Room, id: string): Promise<void> {
  await mx.sendStateEvent(space.roomId, CALENDAR_EVENT as any, {} as any, id);
}

// --- RSVPs -----------------------------------------------------------------------------------

function readMemberRsvps(content: Record<string, unknown>): Record<string, Rsvp> {
  const raw = content[RSVPS_KEY];
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, Rsvp] => entry[1] === 'going' || entry[1] === 'interested')
  );
}

/*
 * Read straight from the member state events, not the SDK's RoomMember objects: when a member event
 * changes, the SDK emits the state change before it updates those, so a listener reading them
 * would see the RSVP from before.
 */

function memberContent(space: Room, userId: string): Record<string, unknown> {
  return space.currentState.getStateEvents(EventType.RoomMember, userId)?.getContent<Record<string, unknown>>() ?? {};
}

/** Who's going and who's interested, per event id, among members still in the Space. */
export function readRsvps(space: Room): Record<string, { going: string[]; interested: string[] }> {
  const result: Record<string, { going: string[]; interested: string[] }> = {};
  for (const event of space.currentState.getStateEvents(EventType.RoomMember) as MatrixEvent[]) {
    const content = event.getContent<Record<string, unknown>>();
    if (content.membership !== 'join') continue;
    for (const [eventId, rsvp] of Object.entries(readMemberRsvps(content))) {
      (result[eventId] ??= { going: [], interested: [] })[rsvp].push(event.getStateKey() ?? '');
    }
  }
  return result;
}

export function readOwnRsvp(space: Room, userId: string, eventId: string): Rsvp | undefined {
  return readMemberRsvps(memberContent(space, userId))[eventId];
}

/**
 * The member content with this RSVP set or cleared, dropping RSVPs to events that no longer exist
 * so the member event doesn't grow forever. Everything else in the content (display name, avatar,
 * feed pointer) is kept as it is. Pure.
 */
export function withRsvp(
  content: Record<string, unknown>,
  eventId: string,
  rsvp: Rsvp | undefined,
  existingEventIds: Set<string>
): Record<string, unknown> {
  const rsvps = Object.fromEntries(Object.entries(readMemberRsvps(content)).filter(([id]) => existingEventIds.has(id)));
  if (rsvp) rsvps[eventId] = rsvp;
  else delete rsvps[eventId];
  const next = { ...content };
  if (Object.keys(rsvps).length > 0) next[RSVPS_KEY] = rsvps;
  else delete next[RSVPS_KEY];
  return next;
}

export async function setRsvp(mx: MatrixClient, space: Room, eventId: string, rsvp: Rsvp | undefined): Promise<void> {
  const userId = mx.getUserId() ?? '';
  // The server's copy, not the synced one, as publishFeedPointer does: writing back a stale copy
  // would undo a name change made moments ago.
  const synced = memberContent(space, userId);
  const current = ((await mx.getStateEvent(space.roomId, EventType.RoomMember, userId).catch(() => undefined)) ?? synced) as
    | Record<string, unknown>
    | undefined;
  if (!current || current.membership !== 'join') throw new Error('You need to be in the Space to RSVP.');
  const existing = new Set(readCalendarEvents(space).map((event) => event.id));
  await mx.sendStateEvent(space.roomId, EventType.RoomMember, withRsvp(current, eventId, rsvp, existing) as any, userId);
}
