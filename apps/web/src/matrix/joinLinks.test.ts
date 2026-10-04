import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { joinTarget, parseJoinTarget } from './joinLinks';

describe('parseJoinTarget', () => {
  it('reads Purrlor invite links from any server', () => {
    expect(parseJoinTarget('https://purr.example/?invite=%21abc%3Apurr.example&via=purr.example')).toEqual({
      target: '!abc:purr.example',
      via: ['purr.example'],
    });
    expect(parseJoinTarget('  https://other.example/?invite=!xyz&via=a.example&via=b.example ')).toEqual({ target: '!xyz', via: ['a.example', 'b.example'] });
  });

  it('reads matrix.to links, encoded or not', () => {
    expect(parseJoinTarget('https://matrix.to/#/#cats:purr.example')).toEqual({ target: '#cats:purr.example', via: [] });
    expect(parseJoinTarget('https://matrix.to/#/%23cats%3Apurr.example')).toEqual({ target: '#cats:purr.example', via: [] });
    expect(parseJoinTarget('https://matrix.to/#/!room:x?via=x.example&via=y.example')).toEqual({ target: '!room:x', via: ['x.example', 'y.example'] });
  });

  it('reads bare addresses and room IDs', () => {
    expect(parseJoinTarget('#cats:purr.example')).toEqual({ target: '#cats:purr.example', via: [] });
    expect(parseJoinTarget('!abc')).toEqual({ target: '!abc', via: [] });
  });

  it('turns down anything else', () => {
    expect(parseJoinTarget('')).toBeUndefined();
    expect(parseJoinTarget('cats please')).toBeUndefined();
    expect(parseJoinTarget('https://purr.example/@luna')).toBeUndefined();
    expect(parseJoinTarget('https://matrix.to/#/@luna:purr.example')).toBeUndefined();
    expect(parseJoinTarget('https://purr.example/?invite=not-a-room')).toBeUndefined();
  });
});

describe('joinTarget', () => {
  // Already known, with its state: what a room is once its first sync is in.
  const room = { roomId: '!r', currentState: { getStateEvents: () => ({}) } } as unknown as Room;
  const client = (joinRoom: unknown) => ({ joinRoom, getRoom: () => room, on: vi.fn(), removeListener: vi.fn() }) as unknown as MatrixClient;

  it('joins plainly first, and through the link’s servers only if that fails', async () => {
    const joinRoom = vi.fn().mockResolvedValueOnce(room);
    await joinTarget(client(joinRoom), { target: '!r', via: ['x.example'] });
    expect(joinRoom).toHaveBeenCalledWith('!r');
    expect(joinRoom).toHaveBeenCalledTimes(1);

    const failingFirst = vi.fn().mockRejectedValueOnce(new Error('no servers')).mockResolvedValueOnce(room);
    await joinTarget(client(failingFirst), { target: '!r', via: ['x.example'] });
    expect(failingFirst).toHaveBeenLastCalledWith('!r', { viaServers: ['x.example'] });
  });

  it('falls back to the server an address names, port included', async () => {
    const joinRoom = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(room);
    await joinTarget(client(joinRoom), { target: '#cats:purr.example:8448', via: [] });
    expect(joinRoom).toHaveBeenLastCalledWith('#cats:purr.example:8448', { viaServers: ['purr.example:8448'] });
  });
});
