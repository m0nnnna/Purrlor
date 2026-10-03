import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { Room } from 'matrix-js-sdk';
import { emoteLibraryAtom, peerEmotesAtom } from '../../app/state/emoteLibrary';
import type { PeerEmoteSet } from '../peerEmotes';
import { mergeByShortcode, type Emote } from '../emotes';
import { useMatrixClient } from '../MatrixClientContext';
import { usePersonalEmotePacks } from './usePersonalEmotePacks';

/** This server's global emote library room, once joined (EmoteLibraryWatcher keeps it current).
 *  Re-renders whenever anything in the library changes. */
export function useEmoteLibraryRoom(): Room | undefined {
  const mx = useMatrixClient();
  const { roomId } = useAtomValue(emoteLibraryAtom);
  return roomId ? mx.getRoom(roomId) ?? undefined : undefined;
}

/** `emotes` with the global library's and your own MSC2545 personal packs (personalEmotePacks.ts
 *  — Element/Cinny's "these emotes follow me" packs, im.ponies.user_emotes/emote_rooms) added
 *  underneath — for places given a fixed emote list (post cards, comments, useRoomEmotes.ts)
 *  rather than a room to read one from. `emotes` (the more room-specific list) wins a collision;
 *  the library sits under even your own personal packs, as the widest scope of all. */
export function useWithLibraryEmotes(emotes: Emote[]): Emote[] {
  const library = useAtomValue(emoteLibraryAtom).emotes;
  const peerEmotes = usePeerEmotes();
  const peers = useMemo(() => peerEmotes.flatMap((peer) => peer.emotes), [peerEmotes]);
  const personalPacks = usePersonalEmotePacks();
  const personalEmotes = useMemo(() => personalPacks.flatMap((pack) => pack.emotes), [personalPacks]);
  // Peers' emotes underneath everything: their shortcodes are renamed, so they only ever fill in.
  return useMemo(() => mergeByShortcode(peers, library, personalEmotes, emotes), [peers, library, personalEmotes, emotes]);
}

/** Peers' emotes and stickers, without any this server's library moderators have hidden. */
export function usePeerEmotes(): PeerEmoteSet[] {
  const peers = useAtomValue(peerEmotesAtom);
  const hiddenMxcUrls = useAtomValue(emoteLibraryAtom).hiddenMxcUrls;
  return useMemo(() => {
    if (hiddenMxcUrls.length === 0) return peers;
    const hidden = new Set(hiddenMxcUrls);
    return peers.map((peer) => ({
      ...peer,
      emotes: peer.emotes.filter((emote) => !hidden.has(emote.mxcUrl)),
      stickers: peer.stickers.filter((sticker) => !hidden.has(sticker.mxcUrl)),
    }));
  }, [peers, hiddenMxcUrls]);
}

/** Every mxc URL a global-library moderator has hidden — for filtering a message's own embedded
 *  emotes (renderMessageText.tsx's formatted_body parsing), which can reference an image outside
 *  any list this app already leaves hidden ones out of. */
export function useHiddenLibraryImages(): Set<string> {
  const hiddenMxcUrls = useAtomValue(emoteLibraryAtom).hiddenMxcUrls;
  return useMemo(() => new Set(hiddenMxcUrls), [hiddenMxcUrls]);
}
