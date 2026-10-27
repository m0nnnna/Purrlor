import { atom } from 'jotai';
import type { PublicStream } from '../../matrix/liveStream';

/**
 * Your own stream, for the whole app: the live bar (LiveStreamBar.tsx) reads it wherever you go, as
 * a voice call keeps going while you look at other things. The connection itself is in
 * streamerSession.ts, loaded only once you go live (livekit-client is its own chunk).
 */
export type StreamerStatus =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'live'; stream: PublicStream; viewers: number; micOn: boolean; posted: boolean }
  | { phase: 'stopping'; stream: PublicStream }
  | { phase: 'error'; message: string };

export const streamerAtom = atom<StreamerStatus>({ phase: 'idle' });

/** The watch page open in the main pane (StreamWatchView.tsx), over whatever else is showing. */
export type OpenStream = { owner: string; streamId: string };
export const openStreamAtom = atom<OpenStream | null>(null);
