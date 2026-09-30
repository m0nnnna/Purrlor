import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { ClientEvent, EventType, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { findParentSpaceId } from './spaceChildren';

function space(roomId: string, children: string[]): Room & { children: string[] } {
  const s = {
    roomId,
    children,
    isSpaceRoom: () => true,
    currentState: {
      getStateEvents: () =>
        s.children.map((id) => ({ getStateKey: () => id, getContent: () => ({ via: ['x'] }) }) as unknown as MatrixEvent),
    },
  };
  return s as unknown as Room & { children: string[] };
}

describe('findParentSpaceId', () => {
  it('answers from an index, and sees a Space’s new child once its children change', () => {
    const cafe = space('!cafe', ['!general']);
    const rooms: Room[] = [cafe];
    const emitter = new EventEmitter();
    let scans = 0;
    const mx = Object.assign(emitter, {
      getRooms: () => {
        scans += 1;
        return rooms;
      },
    }) as unknown as MatrixClient;

    expect(findParentSpaceId(mx, '!general')).toBe('!cafe');
    expect(findParentSpaceId(mx, '!general')).toBe('!cafe');
    expect(findParentSpaceId(mx, '!random')).toBeNull();
    expect(scans).toBe(1);

    cafe.children.push('!random');
    emitter.emit(RoomStateEvent.Events, { getType: () => EventType.SpaceChild } as MatrixEvent);
    expect(findParentSpaceId(mx, '!random')).toBe('!cafe');

    rooms.push(space('!arcade', ['!games']));
    emitter.emit(ClientEvent.Room);
    expect(findParentSpaceId(mx, '!games')).toBe('!arcade');
  });
});
