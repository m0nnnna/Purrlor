import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { MediaCache, TooLargeError } from './mediaCache.js';

/** A body like fetch's, in chunks of `chunk` bytes. */
function body(size: number, chunk = 1000): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const length = Math.min(chunk, size - sent);
      controller.enqueue(new Uint8Array(length).fill(sent % 251));
      sent += length;
    },
  });
}

describe('MediaCache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'purrlor-media-'));
  after(() => rm(dir, { recursive: true, force: true }));

  it('keeps a copy, with its size and type', async () => {
    const cache = new MediaCache(join(dir, 'a'), 10_000, 100_000);
    const entry = await cache.store('mxc://s/a', 'audio/mpeg', body(4321));
    assert.equal(entry.size, 4321);
    assert.equal((await readFile(entry.path)).length, 4321);
    assert.equal(cache.get('mxc://s/a')?.type, 'audio/mpeg');
  });

  it('refuses a file over the limit and keeps nothing of it', async () => {
    const cache = new MediaCache(join(dir, 'b'), 5000, 100_000);
    await assert.rejects(cache.store('mxc://s/big', 'audio/mpeg', body(5001)), TooLargeError);
    assert.equal(cache.get('mxc://s/big'), undefined);
    assert.deepEqual(await readdir(join(dir, 'b')), []);
  });

  it('copies a file once however many ask at the same time', async () => {
    const cache = new MediaCache(join(dir, 'c'), 10_000, 100_000);
    const [one, two] = await Promise.all([cache.store('mxc://s/x', 'audio/ogg', body(3000)), cache.store('mxc://s/x', 'audio/ogg', body(3000))]);
    assert.equal(one.path, two.path);
  });

  it('drops the least recently used copies past its size, and a taken-down one at once', async () => {
    const cache = new MediaCache(join(dir, 'd'), 10_000, 2500);
    const first = await cache.store('mxc://s/1', 'audio/mpeg', body(1000));
    await cache.store('mxc://s/2', 'audio/mpeg', body(1000));
    cache.get('mxc://s/1');
    await cache.store('mxc://s/3', 'audio/mpeg', body(1000));
    assert.ok(cache.get('mxc://s/1'));
    assert.equal(cache.get('mxc://s/2'), undefined);
    await cache.forget('mxc://s/1');
    assert.equal(cache.get('mxc://s/1'), undefined);
    await assert.rejects(access(first.path));
  });
});
