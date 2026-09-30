import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MatrixEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import { MatrixClientContext } from '../MatrixClientContext';
import { usePollTally } from './usePollTally';

const ROOM = '!room:x';

const start = new MatrixEvent({
  event_id: '$poll',
  room_id: ROOM,
  sender: '@alice:x',
  type: 'org.matrix.msc3381.poll.start',
  origin_server_ts: 1,
  content: {
    'org.matrix.msc3381.poll.start': {
      question: { 'org.matrix.msc1767.text': 'Snack?' },
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: 1,
      answers: [
        { id: 'tuna', 'org.matrix.msc1767.text': 'Tuna' },
        { id: 'chicken', 'org.matrix.msc1767.text': 'Chicken' },
      ],
    },
  },
});

function vote(id: string, sender: string, answer: string, ts: number): MatrixEvent {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    sender,
    type: 'org.matrix.msc3381.poll.response',
    origin_server_ts: ts,
    content: {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'org.matrix.msc3381.poll.response': { answers: [answer] },
    },
  });
}

describe('usePollTally', () => {
  it('counts votes the server has from before the loaded timeline, once each', async () => {
    // Loaded: the poll and Carol's vote. The server also has Bob's and Dan's, cast long before,
    // and Carol's again — which mustn't count twice.
    const carol = vote('$carol', '@carol:x', 'tuna', 30);
    const room = {
      roomId: ROOM,
      getLiveTimeline: () => ({ getEvents: () => [start, carol] }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Room;
    const relations = vi.fn(async () => ({
      events: [vote('$bob', '@bob:x', 'chicken', 10), vote('$dan', '@dan:x', 'tuna', 20), vote('$carol', '@carol:x', 'tuna', 30)],
      nextBatch: null,
    }));
    const mx = { getUserId: () => '@alice:x', relations, decryptEventIfNeeded: async () => {} } as unknown as MatrixClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MatrixClientContext.Provider value={mx}>{children}</MatrixClientContext.Provider>
    );

    const { result } = renderHook(() => usePollTally(room, start), { wrapper });

    await waitFor(() => expect(result.current?.tally.totalVotes).toBe(3));
    expect(result.current!.tally.counts).toEqual({ tuna: 2, chicken: 1 });
    expect(relations).toHaveBeenCalledWith(ROOM, '$poll', 'm.reference', null, expect.objectContaining({ dir: 'b' }));
  });
});
