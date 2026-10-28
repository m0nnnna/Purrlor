import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from './publicWeb.js';
import {
  cataloguePage,
  channelName,
  decodeCursor,
  deletedVideoIds,
  encodeCursor,
  livePointer,
  loadWatchKey,
  parseCatalogueQuery,
  parsePeerViews,
  parseVideo,
  playToken,
  readPlayToken,
  storySummary,
  videosFromState,
  ViewCounter,
  watchSettings,
  type CatalogueSources,
  type WatchRoom,
} from './watch.js';

const OWNER = '@nibbles:purr.example';
const PEER = '@mochi:cats.example';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function content(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'mxc://purr.example/file',
    mimetype: 'video/mp4',
    size: 1234,
    duration: 61,
    w: 1280,
    h: 720,
    title: 'Sunday walk',
    description: 'From scratch.',
    thumbnail: 'mxc://purr.example/thumb',
    visibility: 'public',
    uploaded_at: 1_790_000_000_000,
    ...over,
  };
}

function videoEvent(id: string, over: Record<string, unknown> = {}, extra: Partial<RawEvent> = {}): RawEvent {
  return { type: 'xyz.nekous.video', state_key: id, sender: OWNER, event_id: `$first-${id}`, content: content(over), ...extra };
}

const ID = 'aaaaaaaaaaaaaaaa';

describe('watchSettings', () => {
  it('has the defaults, and takes whole positive numbers', () => {
    assert.deepEqual(watchSettings({}), { maxBytes: 500 * 1024 * 1024, maxVideos: 500, playTtlS: 21600 });
    assert.deepEqual(watchSettings({ WATCH_MAX_BYTES: '1000', WATCH_MAX_VIDEOS: '0', WATCH_PLAY_TTL_S: 'x' }), { maxBytes: 1000, maxVideos: 500, playTtlS: 21600 });
  });
});

describe('parseVideo', () => {
  it('reads a first write, whose anchor is its own event id', () => {
    const video = parseVideo(videoEvent(ID), OWNER)!;
    assert.equal(video.id, ID);
    assert.equal(video.anchor, `$first-${ID}`);
    assert.equal(video.visibility, 'public');
  });

  it("keeps an edit's anchor", () => {
    assert.equal(parseVideo(videoEvent(ID, { anchor: '$orig' }, { event_id: '$edit' }), OWNER)!.anchor, '$orig');
  });

  it("ignores one with a field missing or wrong, another mimetype, a bad id, or someone else's", () => {
    const bad: Record<string, unknown>[] = [
      { url: undefined },
      { thumbnail: 'https://x/y.png' },
      { mimetype: 'video/quicktime' },
      { size: 1.5 },
      { duration: 0 },
      { w: '1280' },
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(101) },
      { description: undefined },
      { description: 'x'.repeat(5001) },
      { visibility: 'unlisted' },
      { uploaded_at: undefined },
      { anchor: 'not-an-event' },
    ];
    for (const over of bad) assert.equal(parseVideo(videoEvent(ID, over), OWNER), undefined, JSON.stringify(over));
    assert.equal(parseVideo(videoEvent('short'), OWNER), undefined);
    assert.equal(parseVideo(videoEvent(ID, {}, { sender: '@mod:purr.example' }), OWNER), undefined);
    assert.equal(parseVideo({ ...videoEvent(ID), content: {} }, OWNER), undefined);
    assert.ok(parseVideo(videoEvent(ID, { mimetype: 'video/webm', title: 'x'.repeat(100), description: '' }), OWNER));
  });
});

describe('reading a profile room', () => {
  it('lists videos newest first, at most the cap', () => {
    const state = [
      videoEvent('aaaaaaaaaaaaaaa1', { uploaded_at: 1 }),
      videoEvent('aaaaaaaaaaaaaaa2', { uploaded_at: 3 }),
      videoEvent('aaaaaaaaaaaaaaa3', { uploaded_at: 2 }),
      { ...videoEvent('aaaaaaaaaaaaaaa4'), content: {} },
    ];
    assert.deepEqual(
      videosFromState(state, OWNER, 2).map((v) => v.id),
      ['aaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaa3']
    );
    assert.deepEqual(deletedVideoIds(state, OWNER), ['aaaaaaaaaaaaaaa4']);
  });

  it("reads the channel's name from the owner's membership", () => {
    const state: RawEvent[] = [{ type: 'm.room.member', state_key: OWNER, content: { membership: 'join', displayname: ' Nibbles ' } }];
    assert.equal(channelName(state, OWNER), 'Nibbles');
    assert.equal(channelName([], OWNER), undefined);
  });

  it('reads the live pointer; {} or anyone else’s is not live', () => {
    const pointer = (c: Record<string, unknown>, sender = OWNER): RawEvent[] => [{ type: 'xyz.nekous.live_stream', state_key: '', sender, content: c }];
    const live = { stream_id: 'k3J9x_Qm2PzL0aBc', title: 'Drawing', started_at: 1_790_000_004_000 };
    assert.deepEqual(livePointer(pointer(live), OWNER), live);
    assert.equal(livePointer(pointer({}), OWNER), undefined);
    assert.equal(livePointer(pointer(live, '@else:purr.example'), OWNER), undefined);
    assert.equal(livePointer(pointer({ ...live, stream_id: 'nope' }), OWNER), undefined);
  });

  it('counts stories under a day old, by the owner, not redacted', () => {
    const now = 10 * DAY;
    const story = (id: string, ts: number, over: Partial<RawEvent> = {}): RawEvent => ({
      type: 'xyz.nekous.story',
      event_id: id,
      sender: OWNER,
      origin_server_ts: ts,
      content: { body: 'hi' },
      ...over,
    });
    const events = [
      story('$a', now - HOUR),
      story('$b', now - 2 * HOUR),
      story('$old', now - DAY),
      story('$gone', now - HOUR / 2, { content: {}, unsigned: { redacted_because: {} } }),
      story('$else', now - HOUR / 4, { sender: '@else:purr.example' }),
    ];
    assert.deepEqual(storySummary(events, OWNER, now), { latest_ts: now - HOUR, count: 2 });
    assert.equal(storySummary([story('$old', now - DAY)], OWNER, now), undefined);
  });
});

describe('the catalogue', () => {
  const video = (id: string, at: number, over: Record<string, unknown> = {}) => parseVideo(videoEvent(id, { uploaded_at: at, ...over }), OWNER)!;
  const peerVideo = (id: string, at: number) => parseVideo({ ...videoEvent(id, { uploaded_at: at }), sender: PEER }, PEER)!;
  const rooms: WatchRoom[] = [
    {
      roomId: '!a:purr.example',
      owner: OWNER,
      name: 'Nibbles',
      videos: [video('aaaaaaaaaaaaaaa3', 30, { title: 'Cat tree' }), video('aaaaaaaaaaaaaaa2', 20, { url: 'mxc://purr.example/taken' }), video('aaaaaaaaaaaaaaa1', 10)],
      live: { stream_id: 'k3J9x_Qm2PzL0aBc', title: 'Drawing', started_at: 5 },
      story: { latest_ts: 7, count: 2 },
    },
    { roomId: '!b:cats.example', owner: PEER, videos: [peerVideo('bbbbbbbbbbbbbbb1', 25)], live: { stream_id: 'zzzzzzzzzzzzzzzz', title: 'Gaming', started_at: 9 } },
    { roomId: '!c:purr.example', owner: '@hidden:purr.example', videos: [], story: { latest_ts: 99, count: 1 } },
  ];
  const sources = (over: Partial<CatalogueSources> = {}): CatalogueSources => ({
    rooms,
    excluded: (owner) => owner === '@hidden:purr.example',
    blocked: (url) => url === 'mxc://purr.example/taken',
    views: (owner, id) => (owner === OWNER ? 4 : id === 'bbbbbbbbbbbbbbb1' ? undefined : 0),
    liveOk: () => true,
    maxVideos: 500,
    ...over,
  });

  it('lists every video newest first, with who is live and who has a story, leaving out the hidden and taken down', () => {
    const page = cataloguePage(sources(), parseCatalogueQuery({}));
    assert.deepEqual(
      page.videos.map((v) => v.id),
      ['aaaaaaaaaaaaaaa3', 'bbbbbbbbbbbbbbb1', 'aaaaaaaaaaaaaaa1']
    );
    const first = page.videos[0];
    assert.equal(first.views, 4);
    assert.equal(first.server, 'purr.example');
    assert.equal(first.room_id, '!a:purr.example');
    assert.equal('url' in first, false);
    assert.equal('views' in page.videos[1], false);
    assert.deepEqual(
      page.live.map((l) => [l.owner, l.server]),
      [
        [PEER, 'cats.example'],
        [OWNER, 'purr.example'],
      ]
    );
    assert.deepEqual(page.stories, [{ owner: OWNER, room_id: '!a:purr.example', latest_ts: 7, count: 2 }]);
    assert.equal(page.next, undefined);
  });

  it('pages with a cursor; live and stories head the first page only', () => {
    const first = cataloguePage(sources(), parseCatalogueQuery({ limit: 2 }));
    assert.equal(first.videos.length, 2);
    assert.ok(first.next);
    const second = cataloguePage(sources(), parseCatalogueQuery({ limit: 2, cursor: first.next }));
    assert.deepEqual(
      second.videos.map((v) => v.id),
      ['aaaaaaaaaaaaaaa1']
    );
    assert.equal(second.next, undefined);
    assert.deepEqual([second.live, second.stories], [[], []]);
  });

  it('matches every word of q against title, description and channel name; owners narrows the videos only', () => {
    const ids = (body: Record<string, unknown>) => cataloguePage(sources(), parseCatalogueQuery(body)).videos.map((v) => v.id);
    assert.deepEqual(ids({ q: 'CAT tree' }), ['aaaaaaaaaaaaaaa3']);
    assert.deepEqual(ids({ q: 'nibbles scratch' }), ['aaaaaaaaaaaaaaa3', 'aaaaaaaaaaaaaaa1']);
    assert.deepEqual(ids({ q: 'nothing-like-this' }), []);
    const following = cataloguePage(sources(), parseCatalogueQuery({ owners: [PEER] }));
    assert.deepEqual(
      following.videos.map((v) => v.id),
      ['bbbbbbbbbbbbbbb1']
    );
    assert.equal(following.live.length, 2);
  });

  it("drops a pointer this server's streams don't back", () => {
    const page = cataloguePage(sources({ liveOk: (owner) => owner !== OWNER }), parseCatalogueQuery({}));
    assert.deepEqual(
      page.live.map((l) => l.owner),
      [PEER]
    );
  });

  it('takes limit 1 to 60, 30 otherwise, and treats a bad cursor as the first page', () => {
    assert.equal(parseCatalogueQuery({ limit: 100 }).limit, 60);
    assert.equal(parseCatalogueQuery({ limit: 0 }).limit, 30);
    assert.equal(parseCatalogueQuery({ limit: 2.5 }).limit, 30);
    assert.equal(parseCatalogueQuery({ cursor: 'garbage!' }).cursor, undefined);
    assert.deepEqual(decodeCursor(encodeCursor({ uploaded_at: 3, owner: OWNER, id: ID })), { uploaded_at: 3, owner: OWNER, id: ID });
  });
});

describe('peer view counts', () => {
  it("keeps only that peer's people's counts", () => {
    const views = parsePeerViews({ views: { [`${PEER}|bbbbbbbbbbbbbbb1`]: 3, [`${OWNER}|${ID}`]: 99, [`${PEER}|short`]: 1, [`${PEER}|bbbbbbbbbbbbbbb2`]: -1 } }, 'cats.example');
    assert.deepEqual([...views], [[`${PEER}|bbbbbbbbbbbbbbb1`, 3]]);
    assert.equal(parsePeerViews('nope', 'cats.example').size, 0);
  });
});

describe('play tokens', () => {
  const key = Buffer.alloc(32, 7);
  const grant = { owner: OWNER, id: ID, url: 'mxc://purr.example/file', expires_at: 2_000 };

  it('reads back what was signed until it expires', () => {
    const token = playToken(key, grant);
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(readPlayToken(key, token, 1_000), grant);
    assert.equal(readPlayToken(key, token, 2_000), 'expired');
  });

  it('refuses a token changed, signed with another key, or not one at all', () => {
    const token = playToken(key, grant);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(`${OWNER}|${ID}|mxc://purr.example/other|2000`).toString('base64url');
    assert.equal(readPlayToken(key, `${forged}.${sig}`, 1_000), undefined);
    assert.equal(readPlayToken(Buffer.alloc(32, 8), token, 1_000), undefined);
    assert.equal(readPlayToken(key, payload, 1_000), undefined);
    assert.equal(readPlayToken(key, 42, 1_000), undefined);
    // An expired token that isn't ours is just not ours.
    assert.equal(readPlayToken(Buffer.alloc(32, 8), token, 5_000), undefined);
  });

  it('makes the key once, mode 0600, and keeps it', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'watch-key-')), 'sub', 'watch-key');
    const first = await loadWatchKey(path);
    assert.equal(first.length, 32);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await loadWatchKey(path), first);
  });
});

describe('ViewCounter', () => {
  const noon = Date.UTC(2026, 9, 27, 12);

  it('counts a viewer once per video per UTC day', async () => {
    const views = new ViewCounter(join(await mkdtemp(join(tmpdir(), 'watch-views-')), 'watch-views.json'), 60_000);
    assert.equal(views.count(OWNER, ID, '@a:purr.example', noon), 1);
    assert.equal(views.count(OWNER, ID, '@a:purr.example', noon + HOUR), 1);
    assert.equal(views.count(OWNER, ID, 'ip:192.0.2.1', noon), 2);
    assert.equal(views.count(OWNER, 'bbbbbbbbbbbbbbbb', '@a:purr.example', noon), 1);
    assert.equal(views.count(OWNER, ID, '@a:purr.example', noon + DAY), 3);
    assert.equal(views.views(OWNER, ID), 3);
    assert.equal(views.views(OWNER, 'cccccccccccccccc'), 0);
  });

  it('writes the counts as { views }, reads them back, and drops deleted videos', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'watch-views-')), 'watch-views.json');
    const views = new ViewCounter(file, 60_000);
    views.count(OWNER, ID, '@a:purr.example', noon);
    views.count(OWNER, 'bbbbbbbbbbbbbbbb', '@a:purr.example', noon);
    views.drop(OWNER, ['bbbbbbbbbbbbbbbb']);
    await views.flush();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { views: { [`${OWNER}|${ID}`]: 1 } });
    const again = new ViewCounter(file);
    await again.load();
    assert.equal(again.views(OWNER, ID), 1);
  });

  it('waits before writing, so a burst of plays is one write', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'watch-views-')), 'watch-views.json');
    const views = new ViewCounter(file, 20);
    views.count(OWNER, ID, '@a:purr.example', noon);
    views.count(OWNER, ID, '@b:purr.example', noon);
    await assert.rejects(readFile(file, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { views: { [`${OWNER}|${ID}`]: 2 } });
  });
});
