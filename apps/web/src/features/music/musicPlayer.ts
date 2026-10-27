import { atom } from 'jotai';
import type { MusicQueue, RepeatMode } from './musicQueue';

export type { MusicQueue, QueueItem, RepeatMode } from './musicQueue';

export const musicQueueAtom = atom<MusicQueue | null>(null);

/** Whether the player's audio is playing now (as the element reports it, not as asked). */
export const musicPlayingAtom = atom(false);

/** Position and length of the track on, in seconds, as the element reports them. */
export const musicTimeAtom = atom({ time: 0, duration: 0 });

/** The track on couldn't be loaded or decoded. Cleared when another starts. */
export const musicFailedAtom = atom(false);

/**
 * The one audio element (MusicPlayerHost registers it). The controls act on it directly: play,
 * pause and seek are the element's own, and its events keep the atoms above in step.
 */
let audioElement: HTMLAudioElement | null = null;

export function registerMusicAudio(element: HTMLAudioElement | null): void {
  audioElement = element;
}

export function musicAudio(): HTMLAudioElement | null {
  return audioElement;
}

/** Play or pause the track on. */
export function toggleMusic(): void {
  const audio = audioElement;
  if (!audio) return;
  if (audio.paused) void audio.play().catch(() => undefined);
  else audio.pause();
}

/** Where a page's album plays from, so the page can tell its album is the one in the player. */
export function albumSource(ownerId: string | undefined, blockId: string, albumId: string): string {
  return `${ownerId ?? ''}/${blockId}/${albumId}`;
}

/** Whether the queue plays in a shuffled order, and what happens at the end of a track or the queue. Both are remembered on this device. */
const SHUFFLE_KEY = 'nekous_music_shuffle';
const REPEAT_KEY = 'nekous_music_repeat';

export function readMusicShuffle(): boolean {
  try {
    return localStorage.getItem(SHUFFLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMusicShuffle(shuffle: boolean): void {
  try {
    localStorage.setItem(SHUFFLE_KEY, shuffle ? '1' : '0');
  } catch {
    // Not remembered this time; it still applies now.
  }
}

export function readMusicRepeat(): RepeatMode {
  try {
    const stored = localStorage.getItem(REPEAT_KEY);
    return stored === 'all' || stored === 'one' ? stored : 'off';
  } catch {
    return 'off';
  }
}

export function saveMusicRepeat(repeat: RepeatMode): void {
  try {
    localStorage.setItem(REPEAT_KEY, repeat);
  } catch {
    // As above.
  }
}

const shuffleBaseAtom = atom(readMusicShuffle());
const repeatBaseAtom = atom(readMusicRepeat());

/** Shuffle on or off. MusicPlayerHost keeps the queue's play order in step with it. */
export const musicShuffleAtom = atom(
  (get) => get(shuffleBaseAtom),
  (_get, set, shuffle: boolean) => {
    set(shuffleBaseAtom, shuffle);
    saveMusicShuffle(shuffle);
  }
);

export const musicRepeatAtom = atom(
  (get) => get(repeatBaseAtom),
  (_get, set, repeat: RepeatMode) => {
    set(repeatBaseAtom, repeat);
    saveMusicRepeat(repeat);
  }
);

/** Whether the now-playing view is open. */
export const musicNowPlayingOpenAtom = atom(false);
