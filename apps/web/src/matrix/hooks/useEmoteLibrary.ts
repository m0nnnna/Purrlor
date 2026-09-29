import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { Room } from 'matrix-js-sdk';
import { emoteLibraryAtom } from '../../app/state/emoteLibrary';
import { mergeByShortcode, type Emote } from '../emotes';
import { useMatrixClient } from '../MatrixClientContext';

/** This server's global emote library room, once joined (EmoteLibraryWatcher keeps it current).
 *  Re-renders whenever anything in the library changes. */
export function useEmoteLibraryRoom(): Room | undefined {
  const mx = useMatrixClient();
  const { roomId } = useAtomValue(emoteLibraryAtom);
  return roomId ? mx.getRoom(roomId) ?? undefined : undefined;
}

/** `emotes` with the global library's added underneath — for places given a fixed emote list
 *  (post cards, comments) rather than a room to read one from. `emotes` wins a collision. */
export function useWithLibraryEmotes(emotes: Emote[]): Emote[] {
  const library = useAtomValue(emoteLibraryAtom).emotes;
  return useMemo(() => mergeByShortcode(library, emotes), [library, emotes]);
}
