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
    currentState: { getStateEvents: () => null },
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
    startHistoryPrefetch(mx, { gapMs: 10, wait: async (ms) => void waits.push(ms), concurrency: 1 });
    await vi.waitFor(() => expect(Object.keys(limits)).toEqual(['!busy', '!quiet']));
    expect(waits).toEqual([10, 10]);
  });

  it('fills a few rooms at once, so one slow server holds up only its own room', async () => {
    const slow = fakeRoom('!slow', [], msgs(50), 9);
    const fast = fakeRoom('!fast', [], msgs(50), 5);
    let release = () => {};
    const { mx, limits } = client([slow, fast]);
    const paginate = vi.mocked(mx.paginateEventTimeline).getMockImplementation()!;
    vi.mocked(mx.paginateEventTimeline).mockImplementation(async (timeline, opts) => {
      if (timeline === slow.room.getLiveTimeline()) await new Promise<void>((resolve) => (release = resolve));
      return paginate(timeline, opts);
    });
    startHistoryPrefetch(mx, { gapMs: 0, wait: async () => undefined, concurrency: 2 });
    await vi.waitFor(() => expect(needsHistory(fast.room)).toBe(false));
    expect(limits['!slow']).toBeUndefined();
    release();
    await vi.waitFor(() => expect(needsHistory(slow.room)).toBe(false));
  });
});
