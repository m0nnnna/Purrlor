import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { act, renderHook } from '@testing-library/react';
import { EventType, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useRoomEncrypted } from './useRoomEncrypted';

function fakeRoom() {
  const emitter = new EventEmitter();
  let encrypted = false;
  const room = Object.assign(emitter, {
    currentState: { getStateEvents: (type: string) => (type === EventType.RoomEncryption && encrypted ? {} : null) },
  }) as unknown as Room;
  return { room, turnOn: () => ((encrypted = true), emitter.emit(RoomStateEvent.Events, { getType: () => EventType.RoomEncryption } as MatrixEvent)) };
}

describe('useRoomEncrypted', () => {
  it('follows a room being encrypted while it’s open, and is false without a room', () => {
    const { room, turnOn } = fakeRoom();
    const { result } = renderHook(() => useRoomEncrypted(room));
    expect(result.current).toBe(false);
    act(() => turnOn());
    expect(result.current).toBe(true);
    expect(renderHook(() => useRoomEncrypted(undefined)).result.current).toBe(false);
  });
});
