/**
 * What this device keeps between visits besides matrix-js-sdk's own stores: media (the service
 * worker's cache, public/sw.js) and small answers worth not asking for again, such as link
 * previews (a key-value store in IndexedDB, below). Both are deleted on signing out.
 */

/** Must match MEDIA_CACHE in public/sw.js. */
export const MEDIA_CACHE_NAME = 'purrlor-media-v1';
const DB_NAME = 'purrlor-device-cache';
const STORE = 'kv';

type Entry = { value: unknown; expires: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => {
          resolve(req.result);
          sweepExpired(req.result);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Deletes what has expired, once per session when the store opens: an entry is otherwise only
 * dropped when it's asked for again, and most (a post's likes and comments, a profile visited
 * once) never are.
 */
function sweepExpired(db: IDBDatabase): void {
  try {
    const now = Date.now();
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const expires = (cursor.value as Entry | undefined)?.expires;
      if (typeof expires === 'number' && expires < now) cursor.delete();
      cursor.continue();
    };
  } catch {
    // Nothing to sweep, or no room to: the next session tries again.
  }
}

/** A value kept with `putCached`, or undefined when there's none or it has expired. Never throws. */
export async function getCached<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  const entry = await request<Entry | undefined>(db, 'readonly', (store) => store.get(key));
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    void request(db, 'readwrite', (store) => store.delete(key));
    return undefined;
  }
  return entry.value as T;
}

/** Keeps `value` (structured-cloneable) for `ttlMs`. Never throws: a full disk just keeps nothing. */
export async function putCached(key: string, value: unknown, ttlMs: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const entry: Entry = { value, expires: Date.now() + ttlMs };
  await request(db, 'readwrite', (store) => store.put(entry, key));
}

/** Signing out (or deleting the account): nothing this device kept for the account stays. */
export async function clearDeviceCaches(): Promise<void> {
  const db = await Promise.race([openDb(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))]);
  db?.close();
  dbPromise = null;
  await Promise.all([
    typeof caches === 'undefined' ? undefined : caches.delete(MEDIA_CACHE_NAME).catch(() => false),
    typeof indexedDB === 'undefined'
      ? undefined
      : new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(DB_NAME);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        }),
  ]);
}
