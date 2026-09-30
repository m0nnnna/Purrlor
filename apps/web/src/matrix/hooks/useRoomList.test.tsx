import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { MatrixClientContext } from '../MatrixClientContext';
import { useRoomList } from './useRoomList';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const room = (roomId: string, name = roomId) => ({ roomId, name }) as Room;
const stateEvent = (type: string) => ({ getType: () => type }) as MatrixEvent;

function setup(initial: Room[]) {
  const mx = new EventEmitter() as unknown as MatrixClient;
  let rooms = initial;
  const compute = vi.fn(() => rooms);
  const wrapper = ({ children }: { children: ReactNode }) => <MatrixClientContext.Provider value={mx}>{children}</MatrixClientContext.Provider>;
  const hook = renderHook(() => useRoomList(compute, [], { isRelevant: (e) => e.getType() === 'm.space.child' }), { wrapper });
  return {
    hook,
    compute,
    emit: (type: string) => (mx as unknown as EventEmitter).emit(RoomStateEvent.Events, stateEvent(type)),
    setRooms: (next: Room[]) => {
      rooms = next;
    },
  };
}

describe('useRoomList', () => {
  it('ignores state that can’t change the list, and recomputes once per burst of what can', () => {
    vi.useFakeTimers();
    const t = setup([room('!a')]);
    const before = t.compute.mock.calls.length;

    act(() => {
      for (let i = 0; i < 500; i++) t.emit('m.room.member');
    });
    act(() => vi.advanceTimersByTime(100));
    expect(t.compute.mock.calls.length).toBe(before);

    t.setRooms([room('!a'), room('!b')]);
    act(() => {
      for (let i = 0; i < 20; i++) t.emit('m.space.child');
    });
    act(() => vi.advanceTimersByTime(100));
    expect(t.compute.mock.calls.length).toBe(before + 1);
    expect(t.hook.result.current.map((r) => r.roomId)).toEqual(['!a', '!b']);
  });

  it('keeps the same array when nothing a reader sees changed, and a new one when a name did', () => {
    vi.useFakeTimers();
    const t = setup([room('!a', 'general')]);
    const first = t.hook.result.current;

    t.setRooms([room('!a', 'general')]);
    act(() => t.emit('m.space.child'));
    act(() => vi.advanceTimersByTime(100));
    expect(t.hook.result.current).toBe(first);

    t.setRooms([room('!a', 'lobby')]);
    act(() => t.emit('m.space.child'));
    act(() => vi.advanceTimersByTime(100));
    expect(t.hook.result.current).not.toBe(first);
  });
});
