import type { MusicTrack } from '../../matrix/profilePage';

/** A track in the player's queue, with what the player shows beside it. */
export type QueueItem = {
  track: MusicTrack;
  albumTitle?: string;
  /** The album's cover, an mxc:// page image. */
  cover?: string;
  /** Whose page it's from, for "from <name>". */
  ownerId?: string;
  /** The album it's on, and its place there counted from 1, so the song can be linked whatever the queue order. */
  albumId: string;
  trackNumber: number;
};

/**
 * What the app-wide player is playing: one album's tracks and which one is on. `source` names
 * where it came from (an owner, a block and an album) so a page can tell its own album is the one
 * playing. Null when nothing has been played, or the player was closed. `order` is the play order
 * (indexes into `items`) while shuffle is on, and absent otherwise, when items play as listed.
 */
export type MusicQueue = { source: string; items: QueueItem[]; index: number; order?: number[] };

export type RepeatMode = 'off' | 'all' | 'one';

export const REPEAT_MODES: readonly RepeatMode[] = ['off', 'all', 'one'];

export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];
}

/** A play order that visits every item once, starting at `first`, the rest in random order. */
export function shuffledOrder(length: number, first: number, random: () => number = Math.random): number[] {
  const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first >= 0 && first < length ? [first, ...rest] : rest;
}

/** Item indexes in the order they play. */
export function playOrder(queue: MusicQueue): number[] {
  return queue.order && queue.order.length === queue.items.length ? queue.order : queue.items.map((_, i) => i);
}

/** Where the item on is in the play order. */
export function playPosition(queue: MusicQueue): number {
  return playOrder(queue).indexOf(queue.index);
}

/** The queue with shuffle on (a fresh order from the item on) or off (items as listed, from the item on). */
export function withShuffle(queue: MusicQueue, shuffle: boolean, random?: () => number): MusicQueue {
  if (!shuffle) {
    if (!queue.order) return queue;
    const rest = { ...queue };
    delete rest.order;
    return rest;
  }
  if (queue.order && queue.order.length === queue.items.length) return queue;
  return { ...queue, order: shuffledOrder(queue.items.length, queue.index, random) };
}

/** The item index that follows the one on, or null at the end (repeat all wraps to the start). */
export function nextIndex(queue: MusicQueue, repeat: RepeatMode): number | null {
  const order = playOrder(queue);
  const pos = order.indexOf(queue.index);
  if (pos < 0) return order.length ? order[0] : null;
  if (pos + 1 < order.length) return order[pos + 1];
  return repeat === 'all' ? order[0] : null;
}

/** The item index before the one on, or null at the start (repeat all wraps to the end). */
export function previousIndex(queue: MusicQueue, repeat: RepeatMode): number | null {
  const order = playOrder(queue);
  const pos = order.indexOf(queue.index);
  if (pos > 0) return order[pos - 1];
  return repeat === 'all' && order.length ? order[order.length - 1] : null;
}

/** What the queue plays after the item on, in order, as positions in the play order. */
export function upNext(queue: MusicQueue): { position: number; index: number; item: QueueItem }[] {
  const order = playOrder(queue);
  const pos = order.indexOf(queue.index);
  return order.slice(pos + 1).map((index, i) => ({ position: pos + 1 + i, index, item: queue.items[index] }));
}

/** Plays the item at a place in the play order. */
export function jumpTo(queue: MusicQueue, position: number): MusicQueue {
  const index = playOrder(queue)[position];
  return index === undefined ? queue : { ...queue, index };
}

/** Moves an up-next item one place earlier (-1) or later (1). The item on can't be moved. */
export function moveUpNext(queue: MusicQueue, position: number, delta: -1 | 1): MusicQueue {
  const order = playOrder(queue);
  const here = playPosition(queue);
  const to = position + delta;
  if (position <= here || to <= here || to >= order.length) return queue;
  if (queue.order) {
    const next = [...order];
    [next[position], next[to]] = [next[to], next[position]];
    return { ...queue, order: next };
  }
  // Unshuffled, the play order is the item list itself, and everything moved is after the one on.
  const items = [...queue.items];
  [items[position], items[to]] = [items[to], items[position]];
  return { ...queue, items };
}

/** Takes an up-next item out of the queue. The item on can't be removed. */
export function removeUpNext(queue: MusicQueue, position: number): MusicQueue {
  const order = playOrder(queue);
  if (position <= playPosition(queue) || position >= order.length) return queue;
  const removed = order[position];
  const items = queue.items.filter((_, i) => i !== removed);
  const shift = (i: number) => (i > removed ? i - 1 : i);
  const next: MusicQueue = { ...queue, items, index: shift(queue.index) };
  if (queue.order) next.order = order.filter((_, p) => p !== position).map(shift);
  return next;
}
