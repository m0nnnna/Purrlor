import { useEffect, useState } from 'react';
import { ClientEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { readRecentEmotes, RECENT_EMOTES_EVENT } from '../recentEmotes';
import type { Emote } from '../emotes';

/** Live view of recentEmotes.ts's account data — same shape as useSavedMessages.ts. */
export function useRecentEmotes(): Emote[] {
  const mx = useMatrixClient();
  const [items, setItems] = useState<Emote[]>(() => readRecentEmotes(mx));

  useEffect(() => {
    const update = (event: MatrixEvent) => {
      if (event.getType() === RECENT_EMOTES_EVENT) setItems(readRecentEmotes(mx));
    };
    mx.on(ClientEvent.AccountData, update);
    return () => {
      mx.removeListener(ClientEvent.AccountData, update);
    };
  }, [mx]);

  return items;
}
