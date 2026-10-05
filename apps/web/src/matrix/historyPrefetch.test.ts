import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { needsHistory, prefetchHistory, startHistoryPrefetch } from './historyPrefetch';

type Ev = { type: string };

/** A room whose server holds `older` events behind the `have` it has loaded. */
function fakeRoom(roomId: string, have: Ev[], older: Ev[], lastActive = 0) {
  const events = [...have];
  const behind = [...older];
  const timeline = {
    getEvents: () => events.map((e) => ({ getType: () => e.type, isRedacted: () => false })),
    getPaginationToken: () => (behind.length ? 'token' : null),
  };
  const room = {
    roomId,
    isSpaceRoom: () => false,
    getMyMembership: () => 'join',
    getLiveTimeline: () => timeline,
    getLastActiveTimestamp: () => lastActive,
  } as unknown as Room;
  const paginate = (limit: number) => {
    events.unshift(...behind.splice(Math.max(0, behind.length - limit)));
    return behind.length > 0;
  };
  return { room, paginate };
}

const msgs = (n: number) => Array.from({ length: n }, () => ({ type: 'm.room.message' }));
const noise = (n: number) => Array.from({ length: n }, () => ({ type: 'm.room.power_levels' }));

function client(rooms: ReturnType<typeof fakeRoom>[]) {
  const limits: Record<string, number[]> = {};
  const mx = {
    getRooms: () => rooms.map((r) => r.room),
    paginateEventTimeline: vi.fn(async (timeline: unknown, { limit }: { limit: number }) => {
      const target = rooms.find((r) => r.room.getLiveTimeline() === timeline)!;
      (limits[target.room.roomId] ??= []).push(limit);
      return target.paginate(limit);
    }),
  } as unknown as MatrixClient;
  return { mx, limits };
}

describe('history prefetch', () => {
  it('fills a thin room, growing the pages over ones without messages', async () => {
    const buried = fakeRoom('!buried', [], [...msgs(40), ...noise(500)]);
    const { mx, limits } = client([buried]);
    await prefetchHistory(mx, buried.room);
    expect(needsHistory(buried.room)).toBe(false);
    expect(limits['!buried']).toEqual([30, 90, 270, 600]);
  });

  it('leaves alone rooms with enough ready and rooms at their start', () => {
    expect(needsHistory(fakeRoom('!full', msgs(30), msgs(10)).room)).toBe(false);
    expect(needsHistory(fakeRoom('!small', msgs(3), []).room)).toBe(false);
    expect(needsHistory(fakeRoom('!thin', msgs(3), msgs(10)).room)).toBe(true);
  });

  it('shares a fill already running for the same room', async () => {
    const room = fakeRoom('!r', [], msgs(100));
    const { mx } = client([room]);
    await Promise.all([prefetchHistory(mx, room.room), prefetchHistory(mx, room.room)]);
    expect(mx.paginateEventTimeline).toHaveBeenCalledTimes(1);
  });

  it('fills rooms in the background, most recently active first', async () => {
    const quiet = fakeRoom('!quiet', [], msgs(50), 1);
    const busy = fakeRoom('!busy', [], msgs(50), 9);
    const ready = fakeRoom('!ready', msgs(40), msgs(50), 5);
    const { mx, limits } = client([quiet, busy, ready]);
    const waits: number[] = [];
    startHistoryPrefetch(mx, { gapMs: 10, wait: async (ms) => void waits.push(ms) });
    await vi.waitFor(() => expect(Object.keys(limits)).toEqual(['!busy', '!quiet']));
    expect(waits).toEqual([10, 10]);
  });
});
