import { atom } from 'jotai';
import type { WatchVideo } from '../../matrix/videos';

/**
 * The video page open in the main pane (VideoWatchView.tsx), over whatever else is showing. `video`
 * is there when it was opened from a card; a link has only the owner and id, and the page finds it.
 */
export type OpenVideo = { owner: string; id: string; video?: WatchVideo };
export const openVideoAtom = atom<OpenVideo | null>(null);
