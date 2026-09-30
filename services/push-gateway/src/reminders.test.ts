import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReminders, MAX_REMINDERS, parseReminders, remindersOf, setReminders, takeDue } from './reminders.js';

const NOW = 1_800_000_000_000;

beforeEach(() => loadReminders(undefined));

describe('parseReminders', () => {
  it('keeps well-formed reminders, soonest first, and drops the rest', () => {
    const parsed = parseReminders(
      [
        { id: 'b', at: NOW + 2000, title: 'Reminder', body: 'second' },
        { id: 'a', at: NOW + 1000, body: 'first', roomId: '!r', eventId: '$e' },
        { id: 'a', at: NOW + 3000 }, // a repeated id
        { id: '', at: NOW },
        { id: 'c', at: 'soon' },
        { id: 'd', at: NOW + 2 * 365 * 24 * 3600 * 1000 }, // too far ahead
        null,
      ],
      NOW
    );
    assert.deepEqual(
      parsed.map((r) => [r.id, r.title, r.body, r.roomId]),
      [
        ['a', 'Reminder', 'first', '!r'],
        ['b', 'Reminder', 'second', undefined],
      ]
    );
  });

  it('caps each account at the soonest hundred', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, at: NOW + (150 - i) * 1000 }));
    const parsed = parseReminders(many, NOW);
    assert.equal(parsed.length, MAX_REMINDERS);
    assert.equal(parsed[0].id, 'r149');
  });

  it('accepts nothing that isn’t a list', () => {
    assert.deepEqual(parseReminders({ id: 'a', at: NOW }, NOW), []);
  });
});

describe('the reminder store', () => {
  it('replaces an account’s list, and hands out only what’s due, once', () => {
    setReminders('@alice:x', parseReminders([{ id: 'soon', at: NOW - 1 }, { id: 'later', at: NOW + 60_000 }], NOW));
    setReminders('@bob:x', parseReminders([{ id: 'bob', at: NOW - 5 }], NOW));

    const due = takeDue(NOW);
    assert.deepEqual(
      due.map(({ owner, reminder }) => [owner, reminder.id]).sort(),
      [
        ['@alice:x', 'soon'],
        ['@bob:x', 'bob'],
      ]
    );
    assert.deepEqual(takeDue(NOW), []);
    assert.deepEqual(remindersOf('@alice:x').map((r) => r.id), ['later']);

    // A new list replaces the old: a reminder cancelled elsewhere is simply not in it.
    setReminders('@alice:x', []);
    assert.deepEqual(remindersOf('@alice:x'), []);
  });

  it('survives a restart when it has a file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reminders-')), 'reminders.json');
    loadReminders(file);
    setReminders('@alice:x', parseReminders([{ id: 'a', at: Date.now() + 60_000, body: 'hi' }]));
    assert.ok(readFileSync(file, 'utf8').includes('"a"'));

    loadReminders(file);
    assert.deepEqual(remindersOf('@alice:x').map((r) => r.body), ['hi']);
  });
});
