import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { addRoomToSpace } from './spaceChildren';

function room(roomId: string, parents: Record<string, Record<string, unknown>> = {}): Room {
  return {
    roomId,
    currentState: {
      getStateEvents: (type: string) =>
        type === 'm.space.parent' ? Object.entries(parents).map(([key, content]) => ({ getStateKey: () => key, getContent: () => content })) : [],
    },
  } as unknown as Room;
}

describe('addRoomToSpace', () => {
  const setup = () => {
    const sendStateEvent = vi.fn(async (..._args: unknown[]) => ({}));
    return { mx: { getUserId: () => '@me:purr.example', sendStateEvent } as unknown as MatrixClient, sendStateEvent };
  };
  const parentWrite = (calls: unknown[][]) => calls.find(([roomId, type]) => roomId === '!channel' && type === 'm.space.parent')?.[2];

  it('makes the Space canonical for a room with no parent yet', async () => {
    const { mx, sendStateEvent } = setup();
    await addRoomToSpace(mx, room('!space'), room('!channel'));
    expect(parentWrite(sendStateEvent.mock.calls)).toEqual({ via: ['purr.example'], canonical: true });
  });

  it('leaves a shared channel’s first Space canonical, which is where its roles come from', async () => {
    const { mx, sendStateEvent } = setup();
    await addRoomToSpace(mx, room('!second'), room('!channel', { '!first': { via: ['purr.example'], canonical: true } }));
    expect(parentWrite(sendStateEvent.mock.calls)).toEqual({ via: ['purr.example'] });
  });
});
