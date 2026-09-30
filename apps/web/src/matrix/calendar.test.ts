import { describe, expect, it } from 'vitest';
import { parseCalendarEvent, pastEvents, upcomingEvents, withRsvp, type CalendarEvent } from './calendar';
import { dueReminders, parseReminders, reminderChoices } from './reminders';

describe('parseCalendarEvent', () => {
  it('reads a complete event', () => {
    expect(
      parseCalendarEvent('e1', '@mod', { title: 'Game night', description: 'Bring snacks', start: 1000, end: 5000, channel_id: '!voice' })
    ).toEqual({ id: 'e1', title: 'Game night', description: 'Bring snacks', start: 1000, end: 5000, channelId: '!voice', location: undefined, createdBy: '@mod' });
  });

  it('treats a cancelled (empty) or malformed event as gone', () => {
    expect(parseCalendarEvent('e1', '@mod', {})).toBeUndefined();
    expect(parseCalendarEvent('e1', '@mod', { title: '  ', start: 1 })).toBeUndefined();
    expect(parseCalendarEvent('e1', '@mod', { title: 'x', start: 'tomorrow' })).toBeUndefined();
  });

  it('drops an end that isn’t after the start', () => {
    expect(parseCalendarEvent('e1', '@mod', { title: 'x', start: 1000, end: 500 })?.end).toBeUndefined();
  });
});

describe('upcoming and past', () => {
  const hour = 60 * 60 * 1000;
  const ev = (id: string, start: number, end?: number): CalendarEvent => ({ id, title: id, description: '', start, end, createdBy: '@m' });
  const now = 10 * hour;

  it('keeps an event upcoming until it ends, or an hour after it starts with no end', () => {
    const events = [ev('done', now - 3 * hour, now - hour), ev('running', now - hour / 2), ev('later', now + hour), ev('long', now - 5 * hour, now + hour)];
    expect(upcomingEvents(events, now).map((e) => e.id)).toEqual(['running', 'later', 'long']);
    expect(pastEvents(events, now).map((e) => e.id)).toEqual(['done']);
  });
});

describe('withRsvp', () => {
  const content = { membership: 'join', displayname: 'Neko', 'xyz.nekous.feed_room': '!feed' };

  it('adds an RSVP and keeps the rest of the member event', () => {
    expect(withRsvp(content, 'e1', 'going', new Set(['e1']))).toEqual({ ...content, 'xyz.nekous.rsvps': { e1: 'going' } });
  });

  it('clears an RSVP, dropping the key when none are left', () => {
    const withOne = { ...content, 'xyz.nekous.rsvps': { e1: 'going' } };
    expect(withRsvp(withOne, 'e1', undefined, new Set(['e1']))).toEqual(content);
  });

  it('forgets RSVPs to events that no longer exist', () => {
    const old = { ...content, 'xyz.nekous.rsvps': { gone: 'going', e1: 'interested' } };
    expect(withRsvp(old, 'e2', 'going', new Set(['e1', 'e2']))['xyz.nekous.rsvps']).toEqual({ e1: 'interested', e2: 'going' });
  });
});

describe('reminders', () => {
  it('offers the menu’s times from now, tomorrow morning at 9', () => {
    const now = new Date(2026, 8, 29, 22, 15);
    const choices = reminderChoices(now);
    expect(choices.map((c) => c.label)).toEqual(['In 20 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow at 9:00']);
    expect(choices[0].at - now.getTime()).toBe(20 * 60 * 1000);
    expect(new Date(choices[3].at)).toEqual(new Date(2026, 8, 30, 9, 0));
  });

  it('splits due reminders from the next one to wait for', () => {
    const items = [{ remindAt: 5 }, { remindAt: 20 }, { remindAt: 10 }];
    expect(dueReminders(items, 10)).toEqual({ due: [{ remindAt: 5 }, { remindAt: 10 }], nextAt: 20 });
    expect(dueReminders([], 10)).toEqual({ due: [], nextAt: undefined });
  });

  it('reads only well-formed reminders', () => {
    expect(
      parseReminders({ items: [{ id: 'a', roomId: '!r', eventId: '$e', remindAt: 1, preview: 'hi' }, { id: 'b' }, 'junk'] })
    ).toEqual([{ id: 'a', roomId: '!r', eventId: '$e', remindAt: 1, preview: 'hi' }]);
    expect(parseReminders(undefined)).toEqual([]);
  });
});
