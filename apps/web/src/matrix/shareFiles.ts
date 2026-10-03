/**
 * The other half of the share target (public/sw.js): pictures and videos shared to the installed
 * app arrive in the service worker, which keeps them in this cache until the page collects them.
 */
export const SHARE_CACHE = 'purrlor-share';

/** Most files a share carries; the composer keeps what fits (MAX_ATTACHMENTS) and says so. */
export const MAX_SHARED_FILES = 10;

/**
 * Reads the `count` files the worker stored, then empties the cache so a reload can't share them
 * twice. Missing or unreadable ones are skipped; resolves to [] when the Cache API isn't there.
 */
export async function takeSharedFiles(count: number, storage: CacheStorage | undefined = globalThis.caches): Promise<File[]> {
  if (!storage || !Number.isInteger(count) || count < 1) return [];
  const files: File[] = [];
  try {
    const cache = await storage.open(SHARE_CACHE);
    for (let i = 0; i < Math.min(count, MAX_SHARED_FILES); i++) {
      const response = await cache.match(`/share-target/files/${i}`);
      if (!response) continue;
      const type = response.headers.get('Content-Type') ?? '';
      if (!/^(image|video)\//.test(type)) continue;
      let name = `shared-${i + 1}`;
      try {
        name = decodeURIComponent(response.headers.get('X-File-Name') ?? '') || name;
      } catch {
        // A name that doesn't decode keeps the fallback.
      }
      // The bytes, not response.blob(): a Blob from another realm (a test environment's fetch) isn't
      // taken as one by File, which would store the text "[object Blob]" instead.
      files.push(new File([await response.arrayBuffer()], name, { type }));
    }
  } catch {
    // The cache can't be read (private browsing, say): nothing to share.
  } finally {
    try {
      await storage.delete(SHARE_CACHE);
    } catch {
      // Left for the worker's next share to clear.
    }
  }
  return files;
}
