import type { CalendarEvent } from './calendar';

/**
 * A Space's events as an iCalendar file (.ics, RFC 5545), for adding to Google Calendar, Apple
 * Calendar, Outlook and the like. A file to import, not a live subscription: a subscription would
 * need a public URL that serves the events, and they're private to the Space.
 */

const CRLF = '\r\n';
/** An event with no end is an hour, as the calendar itself counts it (upcomingEvents). */
const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

/** UTC as iCalendar wants it: 20261001T190000Z. */
export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Backslash, semicolon, comma and line breaks are special in a text value. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines are at most 75 bytes; a longer one continues on the next line after a single space. */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // A continuation line spends one byte on its leading space.
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

function eventLines(event: CalendarEvent, spaceId: string, stamp: number): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${event.id}@${spaceId.replace(/[^A-Za-z0-9.-]/g, '')}`,
    `DTSTAMP:${icsDate(stamp)}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end && event.end > event.start ? event.end : event.start + DEFAULT_LENGTH_MS)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${icsEscape(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${icsEscape(event.location)}`] : []),
    'END:VEVENT',
  ];
}

/** The file's text for these events. `channelNames` (by room ID) stand in for a location when an event happens in a channel. */
export function buildIcs(
  events: CalendarEvent[],
  { spaceId, spaceName, channelNames = {}, now = Date.now() }: { spaceId: string; spaceName: string; channelNames?: Record<string, string>; now?: number }
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Purrlor//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(spaceName)}`,
    ...events.flatMap((event) =>
      eventLines(
        !event.location && event.channelId && channelNames[event.channelId] ? { ...event, location: `#${channelNames[event.channelId]} in ${spaceName}` } : event,
        spaceId,
        now
      )
    ),
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join(CRLF) + CRLF;
}

/** A file name from a title: "Movie night!" -> "movie-night". */
export function fileNameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'events';
}

/** Hands the browser a text file to save. */
export function downloadTextFile(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
