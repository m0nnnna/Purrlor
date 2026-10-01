import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageHidden } from './publicWeb';

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
