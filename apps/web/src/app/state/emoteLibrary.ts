import { atom } from 'jotai';
import type { Emote, Sticker } from '../../matrix/emotes';

/**
 * The global emote library (matrix/emoteLibrary.ts), kept current by EmoteLibraryWatcher — read
 * from here rather than each emote-using component listening to the library room itself, since
 * every post card on screen renders emotes. `roomId` is null while there's no library (not set up
 * on this server, or not joined yet).
 */
export type EmoteLibraryState = { roomId: string | null; emotes: Emote[]; stickers: Sticker[] };

export const EMPTY_EMOTE_LIBRARY: EmoteLibraryState = { roomId: null, emotes: [], stickers: [] };

export const emoteLibraryAtom = atom<EmoteLibraryState>(EMPTY_EMOTE_LIBRARY);
