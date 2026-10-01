import { useEffect, useState } from 'react';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useAtomValue } from 'jotai';
import { profileRevisionAtom } from '../../app/state/feed';
import { useMatrixClient } from '../MatrixClientContext';
import { PROFILE_PAGE_EVENT, type ProfilePage } from '../profilePage';
import { readProfilePage } from '../profilePageStore';

/**
 * Someone's published profile page, from their profile room (`roomId`; undefined while it isn't
 * known yet, or if they have none). Live for a room this client is in, your own included; read
 * once, and again after your own publish, for anyone else's.
 */
export function useProfilePage(roomId: string | undefined): { page?: ProfilePage; loading: boolean } {
  const mx = useMatrixClient();
  const revision = useAtomValue(profileRevisionAtom);
  const [state, setState] = useState<{ page?: ProfilePage; loading: boolean; roomId?: string }>({ loading: !!roomId });

  useEffect(() => {
    if (!roomId) {
      setState({ loading: false });
      return undefined;
    }
    let cancelled = false;
    const load = () =>
      readProfilePage(mx, roomId).then((page) => {
        if (!cancelled) setState({ page, loading: false, roomId });
      });
    setState((current) => (current.roomId === roomId ? current : { loading: true, roomId }));
    void load();

    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId && event.getType() === PROFILE_PAGE_EVENT) void load();
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      cancelled = true;
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx, roomId, revision]);

  return { page: state.page, loading: state.loading };
}
