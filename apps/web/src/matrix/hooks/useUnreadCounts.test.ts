import { describe, expect, it } from 'vitest';
import type { Room } from 'matrix-js-sdk';
import { hasUnreadMessages } from './useUnreadCounts';

type Fake = { id: string; sender: string; type?: string; redacted?: boolean };

function room(events: Fake[], readIds: string[]): Room {
  return {
    getLiveTimeline: () => ({
      getEvents: () =>
        events.map((e) => ({
          getId: () => e.id,
          getSender: () => e.sender,
          getType: () => e.type ?? 'm.room.message',
          isRedacted: () => !!e.redacted,
        })),
    }),
    hasUserReadEvent: (_userId: string, eventId: string) => readIds.includes(eventId),
  } as unknown as Room;
}

describe('hasUnreadMessages', () => {
  it('is true when someone else has posted since your receipt', () => {
    expect(hasUnreadMessages(room([{ id: '$1', sender: '@bob' }], []), '@me')).toBe(true);
  });

  it('is false once that message is read', () => {
    expect(hasUnreadMessages(room([{ id: '$1', sender: '@bob' }], ['$1']), '@me')).toBe(false);
  });

  it('is false when your own message is the latest', () => {
    expect(hasUnreadMessages(room([{ id: '$1', sender: '@bob' }, { id: '$2', sender: '@me' }], []), '@me')).toBe(false);
  });

  it('skips events that are not messages, and redacted ones', () => {
    const events = [
      { id: '$1', sender: '@bob' },
      { id: '$2', sender: '@bob', type: 'm.reaction' },
      { id: '$3', sender: '@bob', redacted: true },
    ];
    expect(hasUnreadMessages(room(events, ['$1']), '@me')).toBe(false);
    expect(hasUnreadMessages(room(events, []), '@me')).toBe(true);
  });

  it('counts encrypted messages and polls', () => {
    expect(hasUnreadMessages(room([{ id: '$1', sender: '@bob', type: 'm.room.encrypted' }], []), '@me')).toBe(true);
    expect(hasUnreadMessages(room([{ id: '$1', sender: '@bob', type: 'org.matrix.msc3381.poll.start' }], []), '@me')).toBe(true);
  });
});
