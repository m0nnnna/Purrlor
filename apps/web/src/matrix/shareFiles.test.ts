import { describe, expect, it } from 'vitest';
import { SHARE_CACHE, takeSharedFiles } from './shareFiles';

/** Just enough of CacheStorage for the one cache the share target uses. */
function fakeStorage(entries: Record<string, Response>) {
  const store = new Map(Object.entries(entries));
  const deleted: string[] = [];
  const storage = {
    open: async () => ({ match: async (key: string) => store.get(key) }),
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  } as unknown as CacheStorage;
  return { storage, deleted };
}

const shared = (body: string, type: string, name?: string) =>
  new Response(body, { headers: { 'Content-Type': type, ...(name ? { 'X-File-Name': encodeURIComponent(name) } : {}) } });

describe('takeSharedFiles', () => {
  it('rebuilds each shared file with its name and type, then empties the cache', async () => {
    const { storage, deleted } = fakeStorage({
      '/share-target/files/0': shared('cat', 'image/png', 'my cat.png'),
      '/share-target/files/1': shared('clip', 'video/mp4', 'clip.mp4'),
    });
    const files = await takeSharedFiles(2, storage);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['my cat.png', 'image/png', 3],
      ['clip.mp4', 'video/mp4', 4],
    ]);
    expect(deleted).toEqual([SHARE_CACHE]);
  });

  it('skips missing files and anything that is not an image or video', async () => {
    const { storage } = fakeStorage({
      '/share-target/files/0': shared('<html>', 'text/html', 'x.html'),
      '/share-target/files/2': shared('ok', 'image/webp'),
    });
    const files = await takeSharedFiles(3, storage);
    expect(files.map((f) => f.name)).toEqual(['shared-3']);
  });

  it('keeps a fallback name when the stored one does not decode', async () => {
    const bad = new Response('x', { headers: { 'Content-Type': 'image/png', 'X-File-Name': '%E0%A4%A' } });
    const { storage } = fakeStorage({ '/share-target/files/0': bad });
    expect((await takeSharedFiles(1, storage))[0].name).toBe('shared-1');
  });

  it('shares nothing without a usable count or without the Cache API', async () => {
    const { storage, deleted } = fakeStorage({});
    expect(await takeSharedFiles(0, storage)).toEqual([]);
    expect(await takeSharedFiles(Number.NaN, storage)).toEqual([]);
    expect(await takeSharedFiles(2, undefined)).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
