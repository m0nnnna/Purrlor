import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVideoContent,
  cleanTitle,
  deleteVideo,
  editVideo,
  fetchCatalogue,
  fetchPublicVideo,
  fetchViews,
  formatLength,
  formatViews,
  isVideoId,
  newVideoId,
  parseWatchVideo,
  playVideo,
  readVideoContent,
  titleFromFileName,
  videoTypeOf,
  WatchError,
  type VideoFields,
  type WatchVideo,
} from './videos';

const fields: VideoFields = {
  url: 'mxc://a.test/file',
  mimetype: 'video/mp4',
  size: 1234,
  duration: 61,
  w: 1920,
  h: 1080,
  title: 'Hello',
  description: 'About https://example.com',
  thumbnail: 'mxc://a.test/thumb',
  visibility: 'public',
  uploadedAt: 1_700_000_000_000,
  anchor: '$first',
};
const ID = 'abcDEF0123456789';

afterEach(() => vi.restoreAllMocks());

describe('video ids', () => {
  it('makes 16-character ids from the allowed alphabet', () => {
    for (let i = 0; i < 50; i++) expect(isVideoId(newVideoId())).toBe(true);
  });
  it('rejects the wrong shapes', () => {
    expect(isVideoId('short')).toBe(false);
    expect(isVideoId('abcDEF012345678!')).toBe(false);
    expect(isVideoId(5)).toBe(false);
  });
});

describe('readVideoContent', () => {
  it('round-trips what buildVideoContent writes', () => {
    expect(readVideoContent(buildVideoContent(fields), ID)).toEqual(fields);
  });
  it('treats {} (a deleted video) as nothing', () => {
    expect(readVideoContent({}, ID)).toBeUndefined();
  });
  it('rejects a bad state key, mimetype, fraction, empty or long title', () => {
    const good = buildVideoContent(fields);
    expect(readVideoContent(good, 'nope')).toBeUndefined();
    expect(readVideoContent({ ...good, mimetype: 'video/avi' }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, duration: 1.5 }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, duration: 0 }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, title: '  ' }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, title: 'x'.repeat(101) }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, description: 'x'.repeat(5001) }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, visibility: 'friends' }, ID)).toBeUndefined();
    expect(readVideoContent({ ...good, url: 'https://x' }, ID)).toBeUndefined();
  });
  it('has no anchor on a first write', () => {
    const { anchor: _anchor, ...first } = fields;
    expect(buildVideoContent(first)).not.toHaveProperty('anchor');
    expect(readVideoContent(buildVideoContent(first), ID)?.anchor).toBeUndefined();
  });
});

describe('buildVideoContent', () => {
  it('writes whole numbers only', () => {
    const content = buildVideoContent({ ...fields, size: 10.4, duration: 0.2, w: 99.6, h: 50.5, uploadedAt: 5.5 });
    expect(content).toMatchObject({ size: 10, duration: 1, w: 100, h: 51, uploaded_at: 6 });
  });
});

describe('cleanTitle', () => {
  it('makes one trimmed line of at most 100 characters', () => {
    expect(cleanTitle('  a\n b\t c ')).toBe('a b c');
    expect(cleanTitle('x'.repeat(150))).toHaveLength(100);
    expect(cleanTitle('   ')).toBeUndefined();
  });
  it('names a video from its file', () => {
    expect(titleFromFileName('my_cool_clip.mp4')).toBe('my cool clip');
  });
});

describe('videoTypeOf', () => {
  it('uses the type, then the extension', () => {
    expect(videoTypeOf({ type: 'video/webm', name: 'a' })).toBe('video/webm');
    expect(videoTypeOf({ type: '', name: 'a.MP4' })).toBe('video/mp4');
    expect(videoTypeOf({ type: 'video/quicktime', name: 'a.mov' })).toBeUndefined();
    expect(videoTypeOf({ type: 'image/png', name: 'a.mp4' })).toBeUndefined();
  });
});

describe('formatViews', () => {
  it('formats counts', () => {
    expect(formatViews(undefined)).toBe('');
    expect(formatViews(1)).toBe('1 view');
    expect(formatViews(12)).toBe('12 views');
    expect(formatViews(1500)).toBe('1.5K views');
    expect(formatViews(2_000_000)).toBe('2M views');
  });
});

const raw = {
  owner: '@a:x.test',
  id: ID,
  room_id: '!r:x.test',
  title: 'T',
  description: 'D',
  duration: 5,
  w: 1280,
  h: 720,
  mimetype: 'video/webm',
  size: 99,
  thumbnail: 'mxc://x.test/t',
  visibility: 'private',
  uploaded_at: 7,
  anchor: '$a',
  views: 3,
  server: 'x.test',
};

describe('parseWatchVideo', () => {
  it('reads a catalogue video', () => {
    expect(parseWatchVideo(raw)).toMatchObject({ owner: '@a:x.test', roomId: '!r:x.test', uploadedAt: 7, views: 3 });
  });
  it('accepts a public media path as the thumbnail', () => {
    expect(parseWatchVideo({ ...raw, thumbnail: '/api/public/media/x.test/abc' })?.thumbnail).toBe('/api/public/media/x.test/abc');
  });
  it('drops views when absent and rejects broken videos', () => {
    const { views: _views, ...noViews } = raw;
    expect(parseWatchVideo(noViews)).not.toHaveProperty('views');
    expect(parseWatchVideo({ ...raw, id: 'x' })).toBeUndefined();
    expect(parseWatchVideo({ ...raw, thumbnail: 'https://evil/x' })).toBeUndefined();
  });
});

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const mx = {
  getOpenIdToken: vi.fn(async () => ({ access_token: 'tok', token_type: 'Bearer', matrix_server_name: 'x.test', expires_in: 3600 })),
} as never;

describe('the token server API', () => {
  it('reads a catalogue page with its rows', async () => {
    const fetchMock = mockFetch(200, {
      videos: [raw, { nope: 1 }],
      next: 'c2',
      live: [{ owner: '@a:x.test', stream_id: 's1', title: 'Live', started_at: 1, server: 'x.test' }],
      stories: [{ owner: '@a:x.test', room_id: '!r:x.test', latest_ts: 9, count: 2 }],
    });
    const page = await fetchCatalogue(mx, { q: ' cats ', owners: ['@a:x.test'], limit: 10 });
    expect(page.videos).toHaveLength(1);
    expect(page.next).toBe('c2');
    expect(page.live[0]).toMatchObject({ streamId: 's1' });
    expect(page.stories[0]).toMatchObject({ roomId: '!r:x.test', count: 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/public/watch/catalogue');
    expect(JSON.parse(init.body as string)).toMatchObject({ q: 'cats', owners: ['@a:x.test'], limit: 10 });
  });

  it('plays from the owner’s server and returns an absolute address', async () => {
    const fetchMock = mockFetch(200, { url: '/api/public/watch/file/abc', expires_at: 9, views: 4 });
    const answer = await playVideo('https://peer.test', undefined, '@a:peer.test', ID);
    expect(answer.url).toBe('https://peer.test/api/public/watch/file/abc');
    expect(answer.views).toBe(4);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://peer.test/api/public/watch/play');
    expect(JSON.parse(init.body as string)).toEqual({ owner: '@a:peer.test', video_id: ID });
  });

  it('turns refusals into WatchErrors with the code', async () => {
    mockFetch(403, { error: 'no', code: 'hidden' });
    await expect(playVideo('', undefined, '@a:x.test', ID)).rejects.toMatchObject({ status: 403, code: 'hidden' });
    mockFetch(403, { code: 'not_local' });
    await expect(fetchCatalogue(mx)).rejects.toBeInstanceOf(WatchError);
  });

  it('reads view counts, and gives none when the server fails', async () => {
    mockFetch(200, { views: { [`@a:x.test|${ID}`]: 12, bad: 'x' } });
    expect(await fetchViews('', [`@a:x.test|${ID}`])).toEqual({ [`@a:x.test|${ID}`]: 12 });
    mockFetch(500, {});
    expect(await fetchViews('', ['x'])).toEqual({});
  });

  it('reads a public video, and nothing on 404', async () => {
    mockFetch(200, { ...raw, visibility: 'public', thumbnail: '/api/public/media/x.test/abc' });
    expect((await fetchPublicVideo('a:x.test', ID))?.id).toBe(ID);
    mockFetch(404, { code: 'not_found' });
    expect(await fetchPublicVideo('a:x.test', ID)).toBeUndefined();
  });
});

describe('writing events', () => {
  const video: WatchVideo = { ...parseWatchVideo(raw)!, thumbnail: 'mxc://x.test/t' };

  it('deletes with an empty event on the video’s state key', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$e' }));
    await deleteVideo({ sendStateEvent } as never, video);
    expect(sendStateEvent).toHaveBeenCalledWith('!r:x.test', 'xyz.nekous.video', {}, ID);
  });

  it('edits with every field, the anchor, and uploaded_at kept', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$e2' }));
    const getStateEvent = vi.fn(async () => ({ url: 'mxc://x.test/file' }));
    const edited = await editVideo({ sendStateEvent, getStateEvent } as never, video, { title: ' New ', description: 'd', visibility: 'public' });
    const content = (sendStateEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(content).toMatchObject({ url: 'mxc://x.test/file', title: 'New', anchor: '$a', uploaded_at: 7, visibility: 'public', duration: 5, thumbnail: 'mxc://x.test/t' });
    expect(edited.title).toBe('New');
  });
});

describe('formatLength', () => {
  it('shows minutes, and hours when there are any', () => {
    expect(formatLength(7)).toBe('0:07');
    expect(formatLength(247)).toBe('4:07');
    expect(formatLength(3723)).toBe('1:02:03');
  });
});
