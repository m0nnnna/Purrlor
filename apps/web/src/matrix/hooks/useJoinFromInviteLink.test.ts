import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { createElement, type ReactNode } from 'react';
import { MatrixClientContext } from '../MatrixClientContext';
import { useJoinFromInviteLink } from './useJoinFromInviteLink';

function fakeRoom({ isSpace, roomId }: { isSpace: boolean; roomId: string }): Room {
  return {
    roomId,
    isSpaceRoom: () => isSpace,
    currentState: { getStateEvents: () => [] },
  } as unknown as Room;
}

/** A client whose joined room is then known, with its state, as after a sync (joinLinks.ts waits for that). */
function client(joinRoom: (...args: unknown[]) => Promise<Room>): MatrixClient {
  let last: Room | undefined;
  return {
    joinRoom: async (...args: unknown[]) => (last = await joinRoom(...args)),
    getRoom: () => last ?? null,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as MatrixClient;
}

function setUrl(search: string) {
  window.history.replaceState({}, '', `/${search}`);
}

describe('useJoinFromInviteLink', () => {
  beforeEach(() => {
    setUrl('');
  });

  afterEach(() => {
    setUrl('');
  });

  function wrapper(mx: MatrixClient) {
    return ({ children }: { children: ReactNode }) =>
      createElement(MatrixClientContext.Provider, { value: mx }, children);
  }

  it('does nothing when there is no ?invite= param', () => {
    const joinRoom = vi.fn();
    const mx = client(joinRoom);
    renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('tries a plain join first (no via) and strips both params immediately even when via is present', async () => {
    setUrl('?invite=!space%3Aexample.org&via=example.org');
    const joinRoom = vi.fn().mockResolvedValue(fakeRoom({ isSpace: true, roomId: '!space:example.org' }));
    const mx = client(joinRoom);
    const { result } = renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });

    expect(window.location.search).toBe('');
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledWith('!space:example.org');
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('falls back to a via-equipped retry only when the plain join fails — confirmed live this ordering matters both ways', async () => {
    setUrl('?invite=!space%3Aexample.org&via=example.org');
    const joinRoom = vi
      .fn()
      .mockRejectedValueOnce(new Error('no servers that are in the room have been provided'))
      .mockResolvedValueOnce(fakeRoom({ isSpace: true, roomId: '!space:example.org' }));
    const mx = client(joinRoom);
    const { result } = renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(joinRoom).toHaveBeenNthCalledWith(1, '!space:example.org');
    expect(joinRoom).toHaveBeenNthCalledWith(2, '!space:example.org', { viaServers: ['example.org'] });
  });

  it("falls back to the room ID's own :server suffix for the via retry when a link is missing ?via=", async () => {
    setUrl('?invite=!space%3Aexample.org');
    const joinRoom = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(fakeRoom({ isSpace: true, roomId: '!space:example.org' }));
    const mx = client(joinRoom);
    renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });

    await waitFor(() => expect(joinRoom).toHaveBeenCalledTimes(2));
    expect(joinRoom).toHaveBeenNthCalledWith(2, '!space:example.org', { viaServers: ['example.org'] });
  });

  it('surfaces a failure as an error state when both the plain join and the via retry fail', async () => {
    setUrl('?invite=!space%3Aexample.org&via=example.org');
    const joinRoom = vi.fn().mockRejectedValue(new Error('You are not invited to this room'));
    const mx = client(joinRoom);
    const { result } = renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });

    await waitFor(() =>
      expect(result.current).toEqual({ status: 'error', message: 'You are not invited to this room' })
    );
  });

  it('preserves other query params while removing only ?invite= and ?via=', () => {
    setUrl('?invite=!space%3Aexample.org&via=example.org&openRoom=!other%3Aexample.org');
    const joinRoom = vi.fn().mockResolvedValue(fakeRoom({ isSpace: false, roomId: '!space:example.org' }));
    const mx = client(joinRoom);
    renderHook(() => useJoinFromInviteLink(), { wrapper: wrapper(mx) });

    expect(window.location.search).toBe('?openRoom=%21other%3Aexample.org');
  });
});
