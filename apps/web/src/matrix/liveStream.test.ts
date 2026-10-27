import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStream,
  fetchLiveStreams,
  fetchStream,
  formatDuration,
  goLiveRefusalText,
  parseChat,
  parseStream,
  readLivePointer,
  refusalText,
  renameStream,
  StreamError,
  streamBaseFor,
  viewerToken,
  watchPath,
} from './liveStream';
import { parsePublicRoute } from './publicWeb';
import { resetPeersForTests } from './peers';

vi.mock('./openIdToken', () => ({ getOpenIdTokenCached: async () => ({ access_token: 'tok', matrix_server_name: 'purr.example' }) }));

const ID = 'k3J9x_Qm2PzL0aBc';
const live = {
  id: ID,
  owner: '@luna:purr.example',
  title: 'Drawing',
  state: 'live',
  liveAt: 1000,
  endedAt: null,
  viewers: 7,
  chatRoom: '!chat:purr.example',
  thumbnail: `/api/public/streams/${ID}/thumbnail`,
  replay: null,
  expiresAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetPeersForTests();
});

describe('reading what servers say', () => {
  it('takes a stream as given, and nothing that points off its own routes', () => {
    expect(parseStream(live)).toEqual({ ...live, state: 'live' });
    expect(parseStream({ ...live, thumbnail: 'https://evil.example/x.png' })?.thumbnail).toBeNull();
    expect(parseStream({ ...live, replay: { durationMs: 5, url: 'https://evil.example/x.mp4' } })?.replay).toBeNull();
    expect(parseStream({ ...live, chatRoom: '#alias:x' })?.chatRoom).toBeNull();
    expect(parseStream({ ...live, id: 'nope' })).toBeUndefined();
    expect(parseStream({ ...live, state: 'paused' })).toBeUndefined();
  });

  it('reads the pointer in a profile room, and an empty one as nothing', () => {
    expect(readLivePointer({ stream_id: ID, title: 'Drawing', started_at: 5 })).toEqual({ streamId: ID, title: 'Drawing', startedAt: 5 });
    expect(readLivePointer({})).toBeUndefined();
    expect(readLivePointer({ stream_id: '../../x' })).toBeUndefined();
  });

  it('reads chat, keeping only real avatars', () => {
    const chat = parseChat({
      messages: [{ id: '$1', ts: 1, sender: '@a:x', body: 'hi' }, { id: '$2' }],
      authors: { '@a:x': { userId: '@a:x', avatarUrl: 'mxc://x/a' }, '@b:x': { avatarUrl: 'javascript:alert(1)' } },
    });
    expect(chat.messages).toEqual([{ id: '$1', ts: 1, sender: '@a:x', body: 'hi' }]);
    expect(chat.avatars).toEqual({ '@a:x': 'mxc://x/a' });
  });
});

describe('the watch page address', () => {
  it('is /@name/live/<id>, read back by the router', () => {
    expect(watchPath('/@luna', ID)).toBe(`/@luna/live/${ID}`);
    expect(parsePublicRoute(`/@luna/live/${ID}`)).toEqual({ kind: 'live', user: 'luna', streamId: ID });
    expect(parsePublicRoute(`/@mochi:cats.example/live/${ID}`)).toEqual({ kind: 'live', user: 'mochi:cats.example', streamId: ID });
    expect(parsePublicRoute('/@luna/live/short')).toBeUndefined();
  });
});

describe('which server a stream is on', () => {
  it('is here for this server’s people, a peer’s address for theirs, and nowhere else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ peers: [{ serverName: 'cats.example', name: 'Cats', url: 'https://cats.example/' }] })))
    );
    expect(await streamBaseFor('@luna:purr.example', 'purr.example')).toBe('');
    expect(await streamBaseFor('@mochi:cats.example', 'purr.example')).toBe('https://cats.example');
    expect(await streamBaseFor('@eve:elsewhere.example', 'purr.example')).toBeUndefined();
  });
});

describe('talking to the stream’s server', () => {
  it('asks for a viewer token with the OpenID token signed in, and without it signed out', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 't', url: 'wss://lk', identity: 'guest-x', roomName: 'r' })));
    vi.stubGlobal('fetch', fetchMock);
    await viewerToken('https://cats.example', ID, undefined, 'guest-x');
    await viewerToken('', ID, {} as never);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe(`https://cats.example/api/public/streams/${ID}/token`);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ resume: 'guest-x' });
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ openid_token: { access_token: 'tok', matrix_server_name: 'purr.example' } });
  });

  it('turns refusals into what to tell people', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'guest_full', error: 'full' }), { status: 503 })));
    const err = await viewerToken('', ID, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(refusalText(err)).toMatch(/Sign in to watch/);
    expect(goLiveRefusalText(new StreamError(409, 'server_busy', ''))).toMatch(/as many streams/);
  });

  it('reads a gone stream as none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })));
    expect(await fetchStream('', ID)).toBeUndefined();
  });
});

describe('the streamer’s own calls', () => {
  it('renames and deletes with the OpenID token, and passes a refusal on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stream: { ...live, title: 'New' } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'not_ended', error: 'Still live' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await renameStream({} as never, ID, 'New')).title).toBe('New');
    await expect(deleteStream({} as never, ID)).resolves.toBeUndefined();
    const err = await deleteStream({} as never, ID).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'not_ended' });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe(`/api/public/streams/${ID}/title`);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ openid_token: { access_token: 'tok', matrix_server_name: 'purr.example' }, title: 'New' });
    expect(calls[1][0]).toBe(`/api/public/streams/${ID}/delete`);
  });

  it('lists only the streams live now', async () => {
    const ended = { ...live, id: 'k3J9x_Qm2PzL0aBd', state: 'ended' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ streams: [live, ended, { nope: 1 }] }))));
    expect((await fetchLiveStreams('')).map((s) => s.id)).toEqual([ID]);
  });
});

describe('formatDuration', () => {
  it('shows hours only when there are some', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
});
