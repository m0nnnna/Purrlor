import { atom } from 'jotai';
import type { MusicTrack } from '../../matrix/profilePage';

/** A track in the player's queue, with what the player shows beside it. */
export type QueueItem = {
  track: MusicTrack;
  albumTitle?: string;
  /** The album's cover, an mxc:// page image. */
  cover?: string;
  /** Whose page it's from, for "from <name>". */
  ownerId?: string;
};

/**
 * What the app-wide player is playing: one album's tracks and which one is on. `source` names
 * where it came from (an owner, a block and an album) so a page can tell its own album is the one
 * playing. Null when nothing has been played, or the player was closed.
 */
export type MusicQueue = { source: string; items: QueueItem[]; index: number };

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
