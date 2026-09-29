import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearGifCache, fetchKlipySearch, isGifsEnabled, normalizeKlipyItem } from './gifs.js';

const klipyItem = (overrides: Record<string, unknown> = {}) => ({
  id: 8041071659142944,
  slug: 'hello-hi-662',
  title: 'Hello',
  file: {
    hd: {
      gif: { url: 'https://static.klipy.com/hd.gif', width: 640, height: 480, size: 3_900_000 },
      mp4: { url: 'https://static.klipy.com/hd.mp4', width: 640, height: 480, size: 500_000 },
      webp: { url: 'https://static.klipy.com/hd.webp', width: 640, height: 480, size: 800_000 },
    },
    md: {
      gif: { url: 'https://static.klipy.com/md.gif', width: 320, height: 240, size: 2_200_000 },
      mp4: { url: 'https://static.klipy.com/md.mp4', width: 320, height: 240, size: 400_000 },
    },
    sm: { gif: { url: 'https://static.klipy.com/sm.gif', width: 160, height: 120, size: 330_000 } },
    xs: { gif: { url: 'https://static.klipy.com/xs.gif', width: 90, height: 68, size: 101_000 } },
  },
  tags: [],
  type: 'gif',
  blur_preview: 'data:image/jpeg;base64,xyz',
  ...overrides,
});

describe('normalizeKlipyItem', () => {
  it('trims a full Klipy item to id/title/preview/full', () => {
    const gif = normalizeKlipyItem(klipyItem());
    assert.ok(gif);
    assert.equal(gif!.id, '8041071659142944');
    assert.equal(gif!.title, 'Hello');
    // Preview picks the smallest tier available (xs).
    assert.deepEqual(gif!.preview, { url: 'https://static.klipy.com/xs.gif', width: 90, height: 68 });
    // "Full" picks the md tier, with its gif required and mp4/webp carried along when present.
    assert.deepEqual(gif!.full.gif, { url: 'https://static.klipy.com/md.gif', width: 320, height: 240, size: 2_200_000 });
    assert.equal(gif!.full.mp4?.url, 'https://static.klipy.com/md.mp4');
    // md's tier has no webp in this fixture, so it's simply absent, not fabricated from hd's.
    assert.equal(gif!.full.webp, undefined);
  });

  it('falls back through tiers when the preferred ones are missing', () => {
    const gif = normalizeKlipyItem(klipyItem({ file: { hd: klipyItem().file.hd } }));
    assert.ok(gif);
    // No xs/sm/md — preview and full both fall back to hd.
    assert.equal(gif!.preview.url, 'https://static.klipy.com/hd.gif');
    assert.equal(gif!.full.gif.url, 'https://static.klipy.com/hd.gif');
  });

  it('falls back to slug when id is missing', () => {
    const gif = normalizeKlipyItem(klipyItem({ id: undefined }));
    assert.equal(gif?.id, 'hello-hi-662');
  });

  it('drops an item with no usable gif variant anywhere', () => {
    assert.equal(normalizeKlipyItem(klipyItem({ file: { hd: { mp4: klipyItem().file.hd.mp4 } } })), undefined);
  });

  it('drops garbage input without throwing', () => {
    assert.equal(normalizeKlipyItem(null), undefined);
    assert.equal(normalizeKlipyItem('nope'), undefined);
    assert.equal(normalizeKlipyItem({}), undefined);
    assert.equal(normalizeKlipyItem({ id: 1, file: {} }), undefined);
  });
});

describe('isGifsEnabled', () => {
  const original = process.env.KLIPY_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.KLIPY_API_KEY;
    else process.env.KLIPY_API_KEY = original;
  });

  it('is disabled with no key configured', () => {
    delete process.env.KLIPY_API_KEY;
    assert.equal(isGifsEnabled(), false);
  });

  it('is enabled once a key is set', () => {
    process.env.KLIPY_API_KEY = 'test-key';
    assert.equal(isGifsEnabled(), true);
  });
});

describe('fetchKlipySearch', () => {
  const originalKey = process.env.KLIPY_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.KLIPY_API_KEY = 'test-key';
    clearGifCache();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.KLIPY_API_KEY;
    else process.env.KLIPY_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
    clearGifCache();
  });

  it('builds the documented search URL, normalizes results, and derives nextCursor from has_next', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          result: true,
          data: { data: [klipyItem()], current_page: 2, has_next: true },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await fetchKlipySearch({ query: 'cats', cursor: '2', limit: 10, locale: 'us', userId: '@me:example.org' });

    assert.equal(result.results.length, 1);
    assert.equal(result.nextCursor, '3');
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.pathname, '/api/v1/test-key/gifs/search');
    assert.equal(url.searchParams.get('q'), 'cats');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('per_page'), '10');
    assert.equal(url.searchParams.get('locale'), 'us');
    // The caller's real Matrix ID never reaches Klipy — only a stable hash of it.
    assert.notEqual(url.searchParams.get('customer_id'), '@me:example.org');
  });

  it('reports no next page when Klipy says has_next is false', async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => ({ result: true, data: { data: [], current_page: 1, has_next: false } }) }) as unknown as Response) as typeof fetch;
    const result = await fetchKlipySearch({ userId: '@me:example.org' });
    assert.equal(result.nextCursor, null);
  });

  it('serves a repeat query from cache instead of calling Klipy again', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ result: true, data: { data: [klipyItem()], has_next: false } }) } as unknown as Response;
    }) as typeof fetch;

    await fetchKlipySearch({ query: 'cats', userId: '@a:example.org' });
    await fetchKlipySearch({ query: 'cats', userId: '@b:example.org' }); // different user, same query
    assert.equal(calls, 1);
  });

  it('clamps per_page to Klipy search minimum of 8', async () => {
    let seenPerPage = '';
    globalThis.fetch = (async (url: string | URL) => {
      seenPerPage = new URL(url).searchParams.get('per_page') ?? '';
      return { ok: true, json: async () => ({ result: true, data: { data: [], has_next: false } }) } as unknown as Response;
    }) as typeof fetch;
    await fetchKlipySearch({ limit: 1, userId: '@me:example.org' });
    assert.equal(seenPerPage, '8');
  });

  it('rejects when Klipy answers result: false', async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ result: false }) }) as unknown as Response) as typeof fetch;
    await assert.rejects(fetchKlipySearch({ userId: '@me:example.org' }));
  });

  it('rejects on a non-OK response', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
    await assert.rejects(fetchKlipySearch({ userId: '@me:example.org' }));
  });
});
