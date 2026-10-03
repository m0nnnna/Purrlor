import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { checkPassword, spacesOnlyYouRun } from './deleteAccount';

vi.mock('./permissions', () => ({ roomAdmins: (room: { admins: string[] }) => room.admins }));

const me = '@me:x';

function space(name: string, admins: string[], joined: string[], { isSpace = true, membership = 'join' } = {}) {
  return {
    name,
    roomId: `!${name}:x`,
    admins,
    isSpaceRoom: () => isSpace,
    getMyMembership: () => membership,
    getJoinedMembers: () => joined.map((userId) => ({ userId })),
  } as unknown as Room;
}

describe('spacesOnlyYouRun', () => {
  it('lists Spaces where you are the only admin still in them and others are', () => {
    const rooms = [
      space('Mine', [me], [me, '@a:x']),
      space('Shared', [me, '@a:x'], [me, '@a:x']),
      space('Alone', [me], [me]),
      space('AdminLeft', [me, '@gone:x'], [me, '@a:x']),
      space('Channel', [me], [me, '@a:x'], { isSpace: false }),
      space('Left', [me], [me, '@a:x'], { membership: 'leave' }),
    ];
    const mx = { getUserId: () => me, getRooms: () => rooms } as unknown as MatrixClient;
    expect(spacesOnlyYouRun(mx).map((room) => room.name)).toEqual(['Mine', 'AdminLeft']);
  });
});

describe('checkPassword', () => {
  const mx = { getUserId: () => me, getHomeserverUrl: () => 'https://hs.example/' } as unknown as MatrixClient;
  afterEach(() => vi.unstubAllGlobals());

  it('signs in with the password and straight back out of that session', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/login') ? new Response(JSON.stringify({ access_token: 'tmp' }), { status: 200 }) : new Response('{}', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkPassword(mx, 'right')).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://hs.example/_matrix/client/v3/login', 'https://hs.example/_matrix/client/v3/logout']);
    const logout = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(logout[1].headers).toEqual({ Authorization: 'Bearer tmp' });
  });

  it('says no for a wrong password, and fails loudly when the server has trouble', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errcode":"M_FORBIDDEN"}', { status: 403 })));
    expect(await checkPassword(mx, 'wrong')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(checkPassword(mx, 'x')).rejects.toThrow(/500/);
  });
});
