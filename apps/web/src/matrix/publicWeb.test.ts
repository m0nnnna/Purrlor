import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageHidden, fetchPublicFeed, fetchPublicPage, parsePublicRoute, publicMediaUrl, publicPagePath } from './publicWeb';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('fetchPageHidden', () => {
  it('asks the public web about that user', async () => {
    const fetch = answer(200, { hidden: true });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPageHidden('@luna:purr.example')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/public/status/%40luna%3Apurr.example');
  });

  it('counts anything but a clear yes as not hidden', async () => {
    vi.stubGlobal('fetch', answer(200, { hidden: 'true' }));
    expect(await fetchPageHidden('@a:s')).toBe(false);
    vi.stubGlobal('fetch', answer(404, {}));
    expect(await fetchPageHidden('@a:s')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await fetchPageHidden('@a:s')).toBe(false);
  });
});

describe('parsePublicRoute', () => {
  it('reads the three public addresses', () => {
    expect(parsePublicRoute('/feed')).toEqual({ kind: 'feed' });
    expect(parsePublicRoute('/feed/')).toEqual({ kind: 'feed' });
    expect(parsePublicRoute('/@nibbles')).toEqual({ kind: 'page', user: 'nibbles' });
    expect(parsePublicRoute('/@nibbles/post/%24abc')).toEqual({ kind: 'post', user: 'nibbles', eventId: '$abc' });
  });

  it('leaves everything else to the app', () => {
    expect(parsePublicRoute('/')).toBeUndefined();
    expect(parsePublicRoute('/@a/b')).toBeUndefined();
    expect(parsePublicRoute('/@%E0%A4%A')).toBeUndefined();
    expect(parsePublicRoute('/settings')).toBeUndefined();
  });
});

describe('publicMediaUrl', () => {
  it('maps an mxc URL to the public media route, with a thumbnail size when asked', () => {
    expect(publicMediaUrl('mxc://purr.example/abc_DEF-1')).toBe('/api/public/media/purr.example/abc_DEF-1');
    expect(publicMediaUrl('mxc://purr.example/abc', 80, 80)).toBe('/api/public/media/purr.example/abc?width=80&height=80');
  });

  it('refuses anything that is not a plain mxc URL', () => {
    expect(publicMediaUrl('https://evil.example/x')).toBeNull();
    expect(publicMediaUrl('mxc://s/../x')).toBeNull();
    expect(publicMediaUrl('mxc://s/a?b=1')).toBeNull();
    expect(publicMediaUrl('mxc://s);background:url(https:/x')).toBeNull();
    expect(publicMediaUrl("mxc://s'x/abc")).toBeNull();
  });
});

describe('public answers', () => {
  it('tells not found from an error', async () => {
    vi.stubGlobal('fetch', answer(404, { code: 'not_found' }));
    expect(await fetchPublicPage('@a')).toEqual({ status: 'not_found' });
    vi.stubGlobal('fetch', answer(500, {}));
    expect(await fetchPublicPage('@a')).toEqual({ status: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await fetchPublicFeed()).toEqual({ status: 'error' });
  });

  it('asks for one author, and for older posts', async () => {
    const fetch = answer(200, { posts: [], authors: {} });
    vi.stubGlobal('fetch', fetch);
    await fetchPublicFeed({ before: 5, author: '@luna:purr.example' });
    expect(fetch).toHaveBeenCalledWith('/api/public/feed?before=5&author=%40luna%3Apurr.example');
  });

  it('writes a person’s page address from their user ID', () => {
    expect(publicPagePath('@nibbles:purr.example')).toBe('/@nibbles');
  });
});
