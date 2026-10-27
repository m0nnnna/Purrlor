import { describe, expect, it } from 'vitest';
import {
  jumpTo,
  moveUpNext,
  nextIndex,
  nextRepeatMode,
  playOrder,
  previousIndex,
  removeUpNext,
  shuffledOrder,
  upNext,
  withShuffle,
  type MusicQueue,
} from './musicQueue';

const queueOf = (titles: string[], index = 0, order?: number[]): MusicQueue => ({
  source: 'o/b/a',
  index,
  ...(order && { order }),
  items: titles.map((title, i) => ({ track: { url: `mxc://x/${title}`, mimetype: 'audio/ogg', title }, albumId: 'a', trackNumber: i + 1 })),
});
const titles = (queue: MusicQueue) => queue.items.map((item) => item.track.title).join('');
const queued = (queue: MusicQueue) => upNext(queue).map((entry) => entry.item.track.title).join('');
const seeded = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

describe('shuffledOrder', () => {
  it('visits every track once, starting at the one on', () => {
    for (let seed = 1; seed < 20; seed++) {
      const order = shuffledOrder(8, 3, seeded(seed));
      expect(order[0]).toBe(3);
      expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });
});

describe('next and previous', () => {
  it('go through the album in order and stop at the ends', () => {
    const queue = queueOf(['a', 'b', 'c'], 1);
    expect(nextIndex(queue, 'off')).toBe(2);
    expect(previousIndex(queue, 'off')).toBe(0);
    expect(nextIndex({ ...queue, index: 2 }, 'off')).toBeNull();
    expect(previousIndex({ ...queue, index: 0 }, 'off')).toBeNull();
  });

  it('wrap for repeat all, and repeat one still lets next move on', () => {
    const queue = queueOf(['a', 'b', 'c']);
    expect(nextIndex({ ...queue, index: 2 }, 'all')).toBe(0);
    expect(previousIndex(queue, 'all')).toBe(2);
    expect(nextIndex(queue, 'one')).toBe(1);
    expect(nextIndex({ ...queue, index: 2 }, 'one')).toBeNull();
  });

  it('follow the shuffled order, visiting each track once before it ends', () => {
    let queue = withShuffle(queueOf(['a', 'b', 'c', 'd', 'e']), true, seeded(7));
    const seen = [queue.index];
    for (let next = nextIndex(queue, 'off'); next !== null; next = nextIndex(queue, 'off')) {
      queue = { ...queue, index: next };
      seen.push(next);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(nextIndex(queue, 'all')).toBe(seen[0]);
    expect(previousIndex({ ...queue, index: seen[0] }, 'all')).toBe(seen[4]);
  });

  it('treat a one-track queue as wrapping onto itself with repeat all', () => {
    expect(nextIndex(queueOf(['a']), 'all')).toBe(0);
    expect(nextIndex(queueOf(['a']), 'off')).toBeNull();
  });
});

describe('withShuffle', () => {
  it('turning it off returns to album order from the track on', () => {
    const shuffled = withShuffle(queueOf(['a', 'b', 'c', 'd'], 1), true, seeded(3));
    expect(playOrder(shuffled)[0]).toBe(1);
    const moved = jumpTo(shuffled, 2);
    const plain = withShuffle(moved, false);
    expect(plain.order).toBeUndefined();
    expect(plain.index).toBe(moved.index);
    expect(queued(plain)).toBe('abcd'.slice(plain.index + 1));
  });

  it('keeps an order it already has', () => {
    const shuffled = withShuffle(queueOf(['a', 'b', 'c']), true, seeded(2));
    expect(withShuffle(shuffled, true)).toBe(shuffled);
    const plain = queueOf(['a']);
    expect(withShuffle(plain, false)).toBe(plain);
  });
});

describe('the up next list', () => {
  it('lists what plays after the track on and plays from it', () => {
    const queue = queueOf(['a', 'b', 'c', 'd'], 1);
    expect(queued(queue)).toBe('cd');
    expect(jumpTo(queue, 3).index).toBe(3);
  });

  it('moves songs up and down, never past the one on or the end', () => {
    const queue = queueOf(['a', 'b', 'c', 'd'], 0);
    expect(titles(moveUpNext(queue, 3, -1))).toBe('abdc');
    expect(titles(moveUpNext(queue, 1, 1))).toBe('acbd');
    expect(moveUpNext(queue, 1, -1)).toBe(queue);
    expect(moveUpNext(queue, 3, 1)).toBe(queue);
    expect(moveUpNext(queue, 0, 1)).toBe(queue);
  });

  it('moves and removes within a shuffled order', () => {
    const queue = queueOf(['a', 'b', 'c', 'd'], 2, [2, 0, 3, 1]);
    expect(queued(queue)).toBe('adb');
    expect(queued(moveUpNext(queue, 2, 1))).toBe('abd');
    const removed = removeUpNext(queue, 1);
    expect(titles(removed)).toBe('bcd');
    expect(removed.items[removed.index].track.title).toBe('c');
    expect(queued(removed)).toBe('db');
  });

  it('removes a song and keeps the one on playing', () => {
    const queue = queueOf(['a', 'b', 'c'], 0);
    const removed = removeUpNext(queue, 1);
    expect(titles(removed)).toBe('ac');
    expect(removed.index).toBe(0);
    expect(removeUpNext(queue, 0)).toBe(queue);
  });
});

describe('nextRepeatMode', () => {
  it('goes off, all, one, and round', () => {
    expect(nextRepeatMode('off')).toBe('all');
    expect(nextRepeatMode('all')).toBe('one');
    expect(nextRepeatMode('one')).toBe('off');
  });
});
