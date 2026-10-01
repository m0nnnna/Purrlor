import { useEffect, useState } from 'react';
import { ClientEvent, EventType, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { canSendStateEvent } from '../permissions';
import { hasUnseenNews, NEWS_SEEN_ACCOUNT_DATA, readSpaceNews, SPACE_NEWS_EVENT, type SpaceNews } from '../spaceNews';

export type SpaceNewsState = {
  news?: SpaceNews;
  /** There's news you haven't seen yet (matrix/spaceNews.ts). */
  unseen: boolean;
  /** You may write it: your level reaches the news's own in the Space's power levels. */
  canEdit: boolean;
};

function read(mx: ReturnType<typeof useMatrixClient>, space: Room | null): SpaceNewsState {
  if (!space) return { unseen: false, canEdit: false };
  return {
    news: readSpaceNews(space),
    unseen: hasUnseenNews(mx, space),
    canEdit: canSendStateEvent(space, mx.getUserId() ?? '', SPACE_NEWS_EVENT),
  };
}

/** A Space's news, whether you've seen it, and whether you can edit it, live. */
export function useSpaceNews(space: Room | null): SpaceNewsState {
  const mx = useMatrixClient();
  const [state, setState] = useState(() => read(mx, space));

  useEffect(() => {
    const update = () => setState(read(mx, space));
    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() !== space?.roomId) return;
      const type = event.getType();
      if (type === SPACE_NEWS_EVENT || type === EventType.RoomPowerLevels) update();
    };
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === NEWS_SEEN_ACCOUNT_DATA) update();
    };
    update();
    mx.on(RoomStateEvent.Events, onState);
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState);
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx, space]);

  return state;
}
