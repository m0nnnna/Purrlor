import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { ensurePeerRoomReadable, fetchPeers, parsePeersAnswer, peerOf, resetPeersForTests } from './peers';
import { getHomeServer, isRemoteUser, setHomeServer } from './homeServer';
import { handleFor } from './roles';
import { publicPagePath } from './publicWeb';
import { browsePublicSpaces, joinPublicRoom } from './directory';
import { listPeerDirectory, loadUserProfileSource } from './globalFeed';

vi.mock('./deviceCache', () => ({ getCached: vi.fn(async () => undefined), putCached: vi.fn(async () => undefined) }));
vi.mock('./openIdToken', () => ({ getOpenIdTokenCached: async () => ({ access_token: 'tok', matrix_server_name: 'purr.example' }) }));

const PEERS = { peers: [{ serverName: 'cats.example', name: 'Cats', url: 'https://cats.example' }] };

function respond(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body && { body: JSON.parse(init.body as string) }) });
    const route = routes[url];
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => resetPeersForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  setHomeServer(undefined);
});

describe('parsePeersAnswer and peerOf', () => {
  it('keeps well-formed peers, naming one by its server when it has no name', () => {
    expect(parsePeersAnswer({ peers: [{ serverName: 'cats.example', url: 'https://cats.example' }, { name: 'nope' }, 'junk'] })).toEqual([
      { serverName: 'cats.example', name: 'cats.example', url: 'https://cats.example' },
    ]);
    expect(parsePeersAnswer(null)).toEqual([]);
  });

  it('finds the peer a person or a server belongs to', () => {
    const peers = parsePeersAnswer(PEERS);
    expect(peerOf('@mochi:cats.example', peers)?.name).toBe('Cats');
    expect(peerOf('cats.example', peers)?.name).toBe('Cats');
    expect(peerOf('@mochi:dogs.example', peers)).toBeUndefined();
  });
});

describe('fetchPeers', () => {
  it('asks once and reuses the answer', async () => {
    const calls = respond({ '/api/public/peers': { body: PEERS } });
    expect((await fetchPeers()).map((peer) => peer.serverName)).toEqual(['cats.example']);
    await fetchPeers();
    expect(calls).toHaveLength(1);
  });

  it('is an empty list when the token server has no peers route (an older one)', async () => {
    respond({});
    expect(await fetchPeers()).toEqual([]);
  });
});

describe('handles and addresses for a federated instance’s people', () => {
  it('keep their server once this app knows its own', () => {
    setHomeServer('purr.example');
    expect(getHomeServer()).toBe('purr.example');
    expect(isRemoteUser('@mochi:cats.example')).toBe(true);
    expect(handleFor('@luna:purr.example')).toBe('@luna');
    expect(handleFor('@mochi:cats.example')).toBe('@mochi:cats.example');
    expect(publicPagePath('@luna:purr.example')).toBe('/@luna');
    expect(publicPagePath('@mochi:cats.example')).toBe('/@mochi:cats.example');
  });

  it('drop it, as before, while this app’s own server isn’t known', () => {
    expect(isRemoteUser('@mochi:cats.example')).toBe(false);
    expect(handleFor('@mochi:cats.example')).toBe('@mochi');
  });
});

describe('ensurePeerRoomReadable', () => {
  const readableAfter = (joined: { value: boolean }) =>
    ({
      getDomain: () => 'purr.example',
      getRoom: () => null,
      getStateEvent: vi.fn(async () => {
        if (!joined.value) throw new Error('M_FORBIDDEN');
        return {};
      }),
    }) as unknown as MatrixClient;

  it('asks the token server to join a peer’s person’s room, then reads it', async () => {
    const joined = { value: false };
    const calls = respond({ '/api/public/peers': { body: PEERS }, '/api/public/peers/join': { body: { joined: true } } });
    const mx = readableAfter(joined);
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/public/peers/join') joined.value = true;
        return original(url, init);
      })
    );
    expect(await ensurePeerRoomReadable(mx, '@mochi:cats.example', '!room:cats.example')).toBe(true);
    const join = calls.find((call) => call.url === '/api/public/peers/join');
    expect(join?.body).toMatchObject({ user_id: '@mochi:cats.example', room_id: '!room:cats.example', openid_token: { access_token: 'tok' } });
  });

  it('asks for no join for a peer’s room this homeserver can read already', async () => {
    const calls = respond({ '/api/public/peers': { body: PEERS } });
    expect(await ensurePeerRoomReadable(readableAfter({ value: true }), '@mochi:cats.example', '!room:cats.example')).toBe(true);
    expect(calls.some((call) => call.url === '/api/public/peers/join')).toBe(false);
  });

  it('doesn’t show a server that isn’t a peer, even when this homeserver can read the room', async () => {
    respond({ '/api/public/peers': { body: { peers: [] } } });
    expect(await ensurePeerRoomReadable(readableAfter({ value: true }), '@mochi:cats.example', '!room:cats.example')).toBe(false);
  });

  it('never asks for someone on a server that isn’t a peer', async () => {
    const calls = respond({ '/api/public/peers': { body: PEERS } });
    expect(await ensurePeerRoomReadable(readableAfter({ value: false }), '@x:dogs.example', '!room:dogs.example')).toBe(false);
    expect(calls.some((call) => call.url === '/api/public/peers/join')).toBe(false);
  });
});

describe('loadUserProfileSource for a peer’s person', () => {
  it('has the bot join their room first when it can’t be read yet', async () => {
    const owner = '@mochi:cats.example';
    const state = [
      { type: 'm.room.create', state_key: '', sender: owner, content: {} },
      { type: 'xyz.nekous.feed', state_key: '', content: { owner, profile: true } },
      { type: 'm.room.member', state_key: owner, content: { membership: 'join' } },
    ];
    const joined = { value: false };
    respond({ '/api/public/peers': { body: PEERS } });
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/public/peers/join') {
          joined.value = true;
          return new Response('{"joined":true}');
        }
        return original(url, init);
      })
    );
    const mx = {
      getDomain: () => 'purr.example',
      getExtendedProfile: async () => ({ 'xyz.nekous.profile_room': '!profile:cats.example' }),
      getRoom: () => null,
      getStateEvent: async () => {
        if (!joined.value) throw new Error('M_FORBIDDEN');
        return {};
      },
      roomState: async () => {
        if (!joined.value) throw new Error('M_FORBIDDEN');
        return state;
      },
    } as unknown as MatrixClient;
    expect((await loadUserProfileSource(mx, owner))?.roomId).toBe('!profile:cats.example');
    expect(joined.value).toBe(true);
  });
});

describe('peers’ directories', () => {
  it('reads a peer’s directory over federation, each entry tagged with the peer', async () => {
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        { room_id: '!s:cats.example', name: 'Cat Cafe', room_type: 'm.space', world_readable: true, num_joined_members: 3, guest_can_join: false },
        { room_id: '!p:cats.example', name: 'Mochi', room_type: 'xyz.nekous.profile', world_readable: true, num_joined_members: 1, guest_can_join: false },
      ],
    });
    const mx = { publicRooms } as unknown as MatrixClient;
    const dir = await listPeerDirectory(mx, 'cats.example');
    expect(publicRooms).toHaveBeenCalledWith(expect.objectContaining({ server: 'cats.example' }));
    expect(dir.spaces).toEqual([{ roomId: '!s:cats.example', name: 'Cat Cafe', worldReadable: true, server: 'cats.example' }]);
    expect(dir.profiles).toEqual([{ roomId: '!p:cats.example', name: 'Mochi', server: 'cats.example' }]);
  });

  it('Discover browses a peer’s directory and joins through that peer', async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    const joinRoom = vi.fn().mockResolvedValue({ roomId: '!s:cats.example' });
    const mx = { publicRooms, joinRoom } as unknown as MatrixClient;
    await browsePublicSpaces(mx, { server: 'cats.example' });
    expect(publicRooms).toHaveBeenCalledWith(expect.objectContaining({ server: 'cats.example' }));
    await joinPublicRoom(mx, '!s:cats.example', 'cats.example');
    expect(joinRoom).toHaveBeenCalledWith('!s:cats.example', { viaServers: ['cats.example'] });
  });
});

describe('a peer’s directory kept on the device', () => {
  const kept = new Map<string, unknown>();
  beforeEach(() => kept.clear());

  it('shows a kept copy at once and reads a fresh one behind it once it’s old', async () => {
    const { getCached, putCached } = await import('./deviceCache');
    vi.mocked(getCached).mockImplementation(async (key: string) => kept.get(key) as never);
    vi.mocked(putCached).mockImplementation(async (key: string, value: unknown) => void kept.set(key, value));
    const old = { spaces: [], profiles: [{ roomId: '!old:dogs.example', name: 'Old', server: 'dogs.example' }] };
    kept.set('peer-directory:dogs.example', { at: Date.now() - 60 * 60_000, directory: old });
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [{ room_id: '!new:dogs.example', name: 'New', room_type: 'xyz.nekous.profile', world_readable: true, num_joined_members: 1, guest_can_join: false }],
    });
    const dir = await listPeerDirectory({ publicRooms } as unknown as MatrixClient, 'dogs.example');
    expect(dir).toEqual(old);
    await vi.waitFor(() =>
      expect((kept.get('peer-directory:dogs.example') as { directory: typeof old }).directory.profiles[0].roomId).toBe('!new:dogs.example')
    );
  });
});
