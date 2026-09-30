import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from './calendar';
import { buildIcs, fileNameFor, icsDate, icsEscape, icsFold } from './calendarExport';
import { localDayKey, monthGrid } from './calendarMonth';
import { eventNoticeBody } from './calendarNotice';

const event = (over: Partial<CalendarEvent> & { start: number }): CalendarEvent =>
  ({ id: 'e1', title: 'Movie night', description: '', createdBy: '@a:x', ...over }) as CalendarEvent;

describe('the .ics export', () => {
  it('writes UTC dates, escapes text, and ends every line with CRLF', () => {
    expect(icsDate(Date.UTC(2026, 9, 2, 19, 0, 0))).toBe('20261002T190000Z');
    expect(icsEscape('a, b; c\\d\ne')).toBe('a\\, b\\; c\\\\d\\ne');

    const ics = buildIcs([event({ start: Date.UTC(2026, 9, 2, 19), description: 'Bring snacks, please', location: 'Room 4' })], {
      spaceId: '!cafe:example.org',
      spaceName: 'Cat Café',
      now: Date.UTC(2026, 9, 1),
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:e1@cafeexample.org\r\n');
    expect(ics).toContain('DTSTART:20261002T190000Z\r\n');
    // No end given: an hour, as the calendar counts it.
    expect(ics).toContain('DTEND:20261002T200000Z\r\n');
    expect(ics).toContain('DESCRIPTION:Bring snacks\\, please\r\n');
    expect(ics).toContain('LOCATION:Room 4\r\n');
    expect(ics.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });

  it('uses the channel as the location when an event happens in one, and folds long lines by bytes', () => {
    const ics = buildIcs([event({ start: 0, channelId: '!voice', title: 'é'.repeat(80) })], {
      spaceId: '!s',
      spaceName: 'Cafe',
      channelNames: { '!voice': 'Lounge' },
    });
    expect(ics).toContain('LOCATION:#Lounge in Cafe');
    const lines = ics.split('\r\n');
    expect(lines.every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    // Unfolding gives the title back whole.
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'é'.repeat(80)}`);
    expect(icsFold('x'.repeat(200)).split('\r\n ').length).toBe(3);
  });

  it('makes a file name from a title', () => {
    expect(fileNameFor('Movie night!')).toBe('movie-night');
    expect(fileNameFor('!!!')).toBe('events');
  });
});

describe('monthGrid', () => {
  it('lays a month out in whole weeks, with each event on the day it starts', () => {
    const oct2 = new Date(2026, 9, 2, 19).getTime();
    const grid = monthGrid(2026, 9, [event({ id: 'a', start: oct2 }), event({ id: 'b', start: oct2 + 3_600_000 }), event({ id: 'c', start: new Date(2026, 10, 1).getTime() })], 0);

    // October 2026 starts on a Thursday and has 31 days: five weeks from Sunday.
    expect(grid).toHaveLength(5);
    expect(grid.every((row) => row.length === 7)).toBe(true);
    expect(grid[0][4]).toMatchObject({ day: 1, inMonth: true });
    expect(grid[0][0]).toMatchObject({ day: 27, inMonth: false });
    expect(grid[0][5].events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(grid.flat().some((cell) => cell.events.some((e) => e.id === 'c'))).toBe(false);
    expect(localDayKey(oct2)).toBe('2026-10-02');
  });

  it('can start the week on Monday', () => {
    const grid = monthGrid(2026, 9, [], 1);
    expect(grid[0][3]).toMatchObject({ day: 1 });
    expect(grid[0][0].date.getDay()).toBe(1);
  });
});

describe('eventNoticeBody', () => {
  it('says what and when, and where if it’s somewhere', () => {
    const body = eventNoticeBody({ title: ' Movie night ', start: new Date(2026, 9, 2, 19).getTime(), location: 'Room 4' }, 'en-US');
    expect(body).toBe('📅 New event: Movie night · Fri, Oct 2, 7:00 PM · Room 4');
  });
});
