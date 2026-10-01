import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

/**
 * Local copies of the public web's sound and video files, so a player can seek. Continuwuity
 * ignores `Range` and sends no length, so the media route can't pass a range request through: the
 * first request for a track copies it here (refusing it once it passes `maxFileBytes`), and every
 * request after is answered from the copy. The copies are a cache: least recently used go first
 * past `maxBytes`, a takedown deletes its file's copy at once, and the folder is emptied when the
 * service starts.
 */

export class TooLargeError extends Error {}

type Entry = { path: string; size: number; type: string; lastUsed: number };

/** Counts bytes going past and fails the stream once there are more than `max`. */
export function byteLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > max) done(new TooLargeError(`over ${max} bytes`));
      else done(null, chunk);
    },
  });
}

export class MediaCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  private total = 0;
  private ready: Promise<void>;

  constructor(
    private readonly dir: string,
    readonly maxFileBytes: number,
    private readonly maxBytes: number
  ) {
    this.ready = rm(dir, { recursive: true, force: true })
      .then(() => mkdir(dir, { recursive: true, mode: 0o700 }))
      .then(() => undefined);
  }

  private pathFor(key: string): string {
    return join(this.dir, createHash('sha256').update(key).digest('hex'));
  }

  /** The copy for `key`, if there is one. */
  get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
      // Most recently used last, so eviction can walk from the front.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Copies `body` in as `key` (once, however many requests ask at the same time). Throws
   * TooLargeError, and keeps nothing, for a file over the limit.
   */
  store(key: string, type: string, body: ReadableStream<Uint8Array>): Promise<Entry> {
    const existing = this.pending.get(key);
    if (existing) {
      void body.cancel().catch(() => undefined);
      return existing;
    }
    const job = this.copy(key, type, body).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async copy(key: string, type: string, body: ReadableStream<Uint8Array>): Promise<Entry> {
    await this.ready;
    const path = this.pathFor(key);
    const temp = `${path}.${process.pid}.${Date.now()}.part`;
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as never), byteLimit(this.maxFileBytes), counter, createWriteStream(temp, { mode: 0o600 }));
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    const entry: Entry = { path, size, type, lastUsed: Date.now() };
    this.forgetEntry(key);
    this.entries.set(key, entry);
    this.total += size;
    await this.evict();
    return entry;
  }

  private forgetEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.total -= entry.size;
    return entry;
  }

  /** Deletes the copy of `key` now (a takedown). A request already reading it finishes. */
  async forget(key: string): Promise<void> {
    // A copy still being made would otherwise land after this and stay.
    await this.pending.get(key)?.catch(() => undefined);
    const entry = this.forgetEntry(key);
    if (entry) await unlink(entry.path).catch(() => undefined);
  }

  private async evict(): Promise<void> {
    while (this.total > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value!;
      await this.forget(oldest);
    }
  }
}
