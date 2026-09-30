import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from './calendar';
import { remindersForGateway } from './reminderPush';

const NOW = Date.UTC(2026, 9, 1, 12);
const event = (id: string, start: number): CalendarEvent => ({ id, title: `Event ${id}`, description: '', start, createdBy: '@a' }) as CalendarEvent;

describe('remindersForGateway', () => {
  it('turns message reminders and events you’re going to into one list, soonest first, under the tags a tab uses', () => {
    const list = remindersForGateway(
      [{ id: 'r1', roomId: '!open', eventId: '$m', remindAt: NOW + 3_600_000, preview: 'bring the snacks' }],
      [event('e1', NOW + 30 * 60_000)],
      { now: NOW, encryptedRoomIds: new Set() }
    );
    expect(list.map((r) => [r.id, r.at - NOW, r.title])).toEqual([
      ['event:e1', 15 * 60_000, 'Event e1'],
      ['message:r1', 3_600_000, 'Reminder'],
    ]);
    expect(list[1]).toMatchObject({ body: 'bring the snacks', roomId: '!open', eventId: '$m' });
  });

  it('keeps an encrypted room’s words off the gateway', () => {
    const [reminder] = remindersForGateway(
      [{ id: 'r1', roomId: '!secret', eventId: '$m', remindAt: NOW + 60_000, preview: 'the plan' }],
      [],
      { now: NOW, encryptedRoomIds: new Set(['!secret']) }
    );
    expect(reminder.body).toBe('A message you asked to be reminded about');
  });

  it('leaves out an event that’s well under way', () => {
    expect(remindersForGateway([], [event('old', NOW - 20 * 60_000)], { now: NOW, encryptedRoomIds: new Set() })).toEqual([]);
  });
});
