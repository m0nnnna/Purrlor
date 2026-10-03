import { atom } from 'jotai';
import type { Emote, Sticker } from '../../matrix/emotes';
import type { PeerEmoteSet } from '../../matrix/peerEmotes';

/**
 * The global emote library (matrix/emoteLibrary.ts), kept current by EmoteLibraryWatcher — read
 * from here rather than each emote-using component listening to the library room itself, since
 * every post card on screen renders emotes. `roomId` is null while there's no library (not set up
 * on this server, or not joined yet).
 */
export type EmoteLibraryState = {
  roomId: string | null;
  emotes: Emote[];
  stickers: Sticker[];
  /** Every mxc URL a library moderator has hidden — kept alongside `emotes`/`stickers` (which
   *  already leave these out) so a message's *own* embedded emotes (renderMessageText.tsx's
   *  formatted_body parsing) can be filtered against the same list even when the image isn't in
   *  either reader's-side array at all (a forward, another Space's pack, an Element user's pack). */
  hiddenMxcUrls: string[];
};

export const EMPTY_EMOTE_LIBRARY: EmoteLibraryState = { roomId: null, emotes: [], stickers: [], hiddenMxcUrls: [] };

export const emoteLibraryAtom = atom<EmoteLibraryState>(EMPTY_EMOTE_LIBRARY);

/** Approved peers' libraries (matrix/peerEmotes.ts), kept current by EmoteLibraryWatcher. Already
 *  renamed (`:wave+cats-example:`), so they never collide with this server's own. */
export const peerEmotesAtom = atom<PeerEmoteSet[]>([]);
