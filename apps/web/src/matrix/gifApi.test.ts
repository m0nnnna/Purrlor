import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';

const runtime = vi.hoisted(() => ({ config: {} as Record<string, string> }));
vi.mock('../app/runtimeConfig', () => ({ getRuntimeConfig: () => runtime.config }));

const OPENID_TOKEN = { access_token: 'tok', token_type: 'Bearer', matrix_server_name: 'example.org', expires_in: 3600 };

function fakeClient(): MatrixClient {
  return { getOpenIdToken: vi.fn().mockResolvedValue(OPENID_TOKEN) } as unknown as MatrixClient;
}

const gif = (id = '1') => ({
  id,
  title: 'Hello',
  preview: { url: `https://static.klipy.com/${id}-preview.gif`, width: 90, height: 68 },
  full: { gif: { url: `https://static.klipy.com/${id}-full.gif`, width: 320, height: 240, size: 12345 } },
});

describe('gifApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    runtime.config = {};
  });

  describe('areGifsEnabled', () => {
    it('is false with no gifApiUrl configured, without making a request', async () => {
      const { areGifsEnabled } = await import('./gifApi');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(areGifsEnabled()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks the configured endpoint and reports what it says', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { areGifsEnabled } = await import('./gifApi');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
      vi.stubGlobal('fetch', fetchMock);
      await expect(areGifsEnabled()).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('https://app.example.org/api/gifs/config');
    });

    it('caches the answer instead of asking again on every call', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { areGifsEnabled } = await import('./gifApi');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
      vi.stubGlobal('fetch', fetchMock);
      await areGifsEnabled();
      await areGifsEnabled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('treats a failed probe as disabled rather than throwing', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { areGifsEnabled } = await import('./gifApi');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down'))
      );
      await expect(areGifsEnabled()).resolves.toBe(false);
    });
  });

  describe('searchGifs / trendingGifs', () => {
    it('sends the openid token and query params to the search endpoint', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { searchGifs } = await import('./gifApi');
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [gif()], nextCursor: '2' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const mx = fakeClient();
      const result = await searchGifs(mx, { query: 'cats', limit: 10, locale: 'en' });

      expect(result.results).toHaveLength(1);
      expect(result.nextCursor).toBe('2');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://app.example.org/api/gifs/search',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ openid_token: OPENID_TOKEN, query: 'cats', limit: 10, locale: 'en' });
    });

    it('hits the trending endpoint with no query field', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { trendingGifs } = await import('./gifApi');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [], nextCursor: null }) });
      vi.stubGlobal('fetch', fetchMock);

      await trendingGifs(fakeClient());
      expect(fetchMock).toHaveBeenCalledWith('https://app.example.org/api/gifs/trending', expect.anything());
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ openid_token: OPENID_TOKEN });
    });

    it('rejects with the server-provided error message on a non-OK response', async () => {
      runtime.config = { gifApiUrl: 'https://app.example.org/api/gifs' };
      const { searchGifs } = await import('./gifApi');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'Too many GIF requests' }) })
      );
      await expect(searchGifs(fakeClient(), { query: 'cats' })).rejects.toThrow('Too many GIF requests');
    });

    it('rejects outright with no gifApiUrl configured', async () => {
      const { searchGifs } = await import('./gifApi');
      await expect(searchGifs(fakeClient(), { query: 'cats' })).rejects.toThrow();
    });
  });

  describe('downloadGifAsFile', () => {
    it('downloads the full gif variant and names the file after the title', async () => {
      const { downloadGifAsFile } = await import('./gifApi');
      const blob = new Blob(['gif-bytes'], { type: 'image/gif' });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
      vi.stubGlobal('fetch', fetchMock);

      const file = await downloadGifAsFile(gif('42'));
      expect(fetchMock).toHaveBeenCalledWith('https://static.klipy.com/42-full.gif');
      expect(file.name).toBe('Hello.gif');
      expect(file.type).toBe('image/gif');
      expect(file.size).toBe(blob.size);
    });

    it('strips characters that are unsafe in a filename', async () => {
      const { downloadGifAsFile } = await import('./gifApi');
      const blob = new Blob(['x'], { type: 'image/gif' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));

      const file = await downloadGifAsFile({ ...gif('7'), title: 'a/b:c*d' });
      expect(file.name).toBe('a_b_c_d.gif');
    });

    it('rejects when the download fails', async () => {
      const { downloadGifAsFile } = await import('./gifApi');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(downloadGifAsFile(gif())).rejects.toThrow();
    });
  });
});
