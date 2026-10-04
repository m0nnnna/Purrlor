import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { fetchMedia, isRetryableMediaFailure } from './mediaFetch';

const mx = { getAccessToken: () => 'token', getDomain: () => 'purr.example' } as unknown as MatrixClient;

describe('isRetryableMediaFailure', () => {
  it('retries what may pass', () => {
    expect(isRetryableMediaFailure(null, 'mxc://purr.example/a', 'purr.example')).toBe(true);
    expect(isRetryableMediaFailure(429, 'mxc://purr.example/a', 'purr.example')).toBe(true);
    expect(isRetryableMediaFailure(502, 'mxc://purr.example/a', 'purr.example')).toBe(true);
    expect(isRetryableMediaFailure(504, 'mxc://cats.example/a', 'purr.example')).toBe(true);
  });

  it("retries a 404 only for another server's media", () => {
    expect(isRetryableMediaFailure(404, 'mxc://cats.example/a', 'purr.example')).toBe(true);
    expect(isRetryableMediaFailure(404, 'mxc://purr.example/a', 'purr.example')).toBe(false);
  });

  it('gives up on the rest', () => {
    expect(isRetryableMediaFailure(400, 'mxc://cats.example/a', 'purr.example')).toBe(false);
    expect(isRetryableMediaFailure(403, 'mxc://cats.example/a', 'purr.example')).toBe(false);
  });
});

describe('fetchMedia', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks again after a timeout and returns the answer that worked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchMedia(mx, 'mxc://cats.example/a', 'https://hs/media', true, [0, 0, 0]);
    expect(await res.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer token' } });
  });

  it('stops at once on a final answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMedia(mx, 'mxc://purr.example/a', 'https://hs/media', false, [0, 0])).rejects.toThrow('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after the last retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMedia(mx, 'mxc://cats.example/a', 'https://hs/media', false, [0, 0])).rejects.toThrow('502');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
