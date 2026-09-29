import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { ClientEvent, EventType, RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EMPTY_EMOTE_LIBRARY, emoteLibraryAtom } from '../../app/state/emoteLibrary';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { findEmoteLibrary, getLibraryEmotes, getLibraryStickers, joinEmoteLibrary } from '../../matrix/emoteLibrary';

/** Joining waits a little after start, out of the way of the first screen loading. */
const JOIN_DELAY_MS = 5_000;

/**
 * Keeps you in this server's global emote library (matrix/emoteLibrary.ts) and publishes what's
 * in it to `emoteLibraryAtom`. Renders nothing. Everyone joins, not only people who add emotes:
 * a message's `:shortcode:` is drawn from the reader's own emote list (renderMessageText.tsx), so
 * a global emote only shows for readers who have the library.
 */
export function EmoteLibraryWatcher() {
  const mx = useMatrixClient();
  const setLibrary = useSetAtom(emoteLibraryAtom);

  useEffect(() => {
    let library: Room | undefined;

    const publish = () => {
      setLibrary(
        library
          ? { roomId: library.roomId, emotes: getLibraryEmotes(library), stickers: getLibraryStickers(library) }
          : EMPTY_EMOTE_LIBRARY
      );
    };

    const attach = () => {
      const found = findEmoteLibrary(mx);
      if (found === library) return;
      library?.removeListener(RoomStateEvent.Events, publish);
      library = found;
      library?.on(RoomStateEvent.Events, publish);
      publish();
    };

    // Right after a join the room's type and alias are still arriving with its state.
    const onAnyState = (event: MatrixEvent) => {
      const type = event.getType();
      if (type === EventType.RoomCreate || type === EventType.RoomCanonicalAlias) attach();
    };

    attach();
    mx.on(ClientEvent.Room, attach);
    mx.on(RoomEvent.MyMembership, attach);
    mx.on(RoomStateEvent.Events, onAnyState);
    const joinTimer = setTimeout(() => {
      if (!library) void joinEmoteLibrary(mx);
    }, JOIN_DELAY_MS);

    return () => {
      clearTimeout(joinTimer);
      mx.removeListener(ClientEvent.Room, attach);
      mx.removeListener(RoomEvent.MyMembership, attach);
      mx.removeListener(RoomStateEvent.Events, onAnyState);
      library?.removeListener(RoomStateEvent.Events, publish);
      setLibrary(EMPTY_EMOTE_LIBRARY);
    };
  }, [mx, setLibrary]);

  return null;
}
