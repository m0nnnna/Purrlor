import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Room } from 'matrix-js-sdk';
import { countUnreadMessages, directMessageUnread, hasUnreadMessages, useAnyRoomHasUnread } from './useUnreadCounts';

type Fake = { id: string; sender: string; type?: string; redacted?: boolean };

function room(events: Fake[], readIds: string[], roomId = '!room'): Room {
  return {
    roomId,
    on: () => undefined,
    removeListener: () => undefined,
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

describe('countUnreadMessages', () => {
  it("counts others' messages since your receipt, stopping at it", () => {
    const events = [
      { id: '$1', sender: '@bob' },
      { id: '$2', sender: '@bob' },
      { id: '$3', sender: '@bob', type: 'm.room.encrypted' },
      { id: '$4', sender: '@bob', type: 'm.reaction' },
    ];
    expect(countUnreadMessages(room(events, []), '@me')).toBe(3);
    expect(countUnreadMessages(room(events, ['$1']), '@me')).toBe(2);
  });

  it('stops at your own last message', () => {
    expect(countUnreadMessages(room([{ id: '$1', sender: '@bob' }, { id: '$2', sender: '@me' }, { id: '$3', sender: '@bob' }], []), '@me')).toBe(1);
  });

  it('stops counting at the cap', () => {
    const events = Array.from({ length: 150 }, (_, i) => ({ id: `$${i}`, sender: '@bob' }));
    expect(countUnreadMessages(room(events, []), '@me')).toBe(100);
  });
});

describe('directMessageUnread', () => {
  it("takes the larger of the server's count and the counted one", () => {
    const withServer = (r: Room, total: number) => Object.assign(r, { getUnreadNotificationCount: () => total });
    expect(directMessageUnread(withServer(room([{ id: '$1', sender: '@bob', type: 'm.room.encrypted' }], []), 0), '@me')).toBe(1);
    expect(directMessageUnread(withServer(room([{ id: '$1', sender: '@bob' }], []), 5), '@me')).toBe(5);
  });
});

describe('useAnyRoomHasUnread', () => {
  // A webhook's post: an m.notice, which the server's counts never include.
  const webhookPost = room([{ id: '$1', sender: '@webhook-bot' }], [], '!news');
  const read = room([{ id: '$2', sender: '@bob' }], ['$2'], '!general');

  it('marks a category or Space unread for a message the counts miss', () => {
    const { result } = renderHook(() => useAnyRoomHasUnread([read, webhookPost], '@me', () => false));
    expect(result.current).toBe(true);
  });

  it('leaves out muted channels, and is false when everything is read', () => {
    expect(renderHook(() => useAnyRoomHasUnread([read, webhookPost], '@me', (id) => id === '!news')).result.current).toBe(false);
    expect(renderHook(() => useAnyRoomHasUnread([read], '@me', () => false)).result.current).toBe(false);
  });
});
