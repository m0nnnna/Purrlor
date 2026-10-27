import { atom } from 'jotai';
import type { PublicStream, StreamSource } from '../../matrix/liveStream';

/**
 * Your own stream, for the whole app: the pill (LiveStreamBar.tsx) reads it wherever you go, as
 * a voice call keeps going while you look at other things, and the dashboard (Dashboard.tsx) opens
 * from it. The connection itself is in streamerSession.ts, loaded only once you go live
 * (livekit-client is its own chunk).
 */
export type StreamerStatus =
  | { phase: 'idle' }
  /** Connecting. An OBS stream has its record already and `waiting` until OBS's picture arrives. */
  | { phase: 'starting'; stream?: PublicStream; source?: StreamSource; waiting?: boolean }
  | { phase: 'live'; stream: PublicStream; source: StreamSource; viewers: number; micOn: boolean; soundOn: boolean; posted: boolean }
  | { phase: 'stopping'; stream: PublicStream }
  /** A browser stream found after a reload: its tracks are gone, so it can only be ended. */
  | { phase: 'orphan'; stream: PublicStream }
  | { phase: 'error'; message: string };

export const streamerAtom = atom<StreamerStatus>({ phase: 'idle' });

/** The go-live setup page is open (GoLive.tsx). */
export const setupOpenAtom = atom(false);
/** The dashboard is open over the app (Dashboard.tsx). */
export const dashboardOpenAtom = atom(false);

/** The watch page open in the main pane (StreamWatchView.tsx), over whatever else is showing. */
export type OpenStream = { owner: string; streamId: string };
export const openStreamAtom = atom<OpenStream | null>(null);
