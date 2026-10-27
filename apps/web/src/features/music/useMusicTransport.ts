import { useAtom } from 'jotai';
import { musicAudio, musicQueueAtom, musicRepeatAtom, musicShuffleAtom } from './musicPlayer';
import { nextIndex, nextRepeatMode, previousIndex, type MusicQueue } from './musicQueue';

/** Plays the track from its start again (repeat one, a one-track queue that wraps, back from a few seconds in). */
export function restartMusic(): void {
  const audio = musicAudio();
  if (!audio) return;
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}

/**
 * The player's moves, shared by its bars, the now-playing view, the media keys and the end of a
 * track: next and previous follow shuffle and repeat (musicQueue.ts), `ended` is what to do when
 * a track plays out.
 */
export function useMusicTransport() {
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const [shuffle, setShuffle] = useAtom(musicShuffleAtom);
  const [repeat, setRepeat] = useAtom(musicRepeatAtom);

  const next = nextIndex(queue ?? EMPTY, repeat);
  const previous = previousIndex(queue ?? EMPTY, repeat);

  const go = (index: number | null) => {
    if (!queue || index === null) return;
    if (index === queue.index) restartMusic();
    else setQueue({ ...queue, index });
  };

  return {
    shuffle,
    repeat,
    canNext: queue !== null && next !== null,
    toggleShuffle: () => setShuffle(!shuffle),
    cycleRepeat: () => setRepeat(nextRepeatMode(repeat)),
    next: () => go(next),
    /** Back from a few seconds in starts the track again, as music players do; at the very start of the queue too. */
    previous: () => {
      const audio = musicAudio();
      if (audio && audio.currentTime > 3) restartMusic();
      else if (previous === null) restartMusic();
      else go(previous);
    },
    /** A track played out: again for repeat one, else the next, else stop (the caller marks it not playing). Returns whether it went on. */
    ended: (): boolean => {
      if (repeat === 'one') {
        restartMusic();
        return true;
      }
      if (next === null) return false;
      go(next);
      return true;
    },
  };
}

const EMPTY: MusicQueue = { source: '', items: [], index: 0 };
