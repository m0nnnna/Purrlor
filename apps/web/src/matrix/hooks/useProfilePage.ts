import { useEffect, useState } from 'react';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useAtomValue } from 'jotai';
import { profileRevisionAtom } from '../../app/state/feed';
import { useMatrixClient } from '../MatrixClientContext';
import { PROFILE_PAGE_EVENT, type ProfilePage } from '../profilePage';
import { readProfilePage } from '../profilePageStore';
import { isRemoteUser } from '../homeServer';
import { ensurePeerRoomReadable } from '../peers';

/**
 * Someone's published profile page, from their profile room (`roomId`; undefined while it isn't
 * known yet, or if they have none). Live for a room this client is in, your own included; read
 * once, and again after your own publish, for anyone else's. A federated instance's person's room
 * (`ownerId` on another server) is made readable here first, by the token server's bot joining it
 * (peers.ts), when their instance is an approved peer.
 */
export function useProfilePage(roomId: string | undefined, ownerId?: string): { page?: ProfilePage; loading: boolean } {
  const mx = useMatrixClient();
  const revision = useAtomValue(profileRevisionAtom);
  const [state, setState] = useState<{ page?: ProfilePage; loading: boolean; roomId?: string }>({ loading: !!roomId });

  useEffect(() => {
    if (!roomId) {
      setState({ loading: false });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      // Someone on another server: only through an approved peer (peers.ts).
      const allowed = !ownerId || !isRemoteUser(ownerId) || (await ensurePeerRoomReadable(mx, ownerId, roomId));
      const page = allowed ? await readProfilePage(mx, roomId) : undefined;
      if (!cancelled) setState({ page, loading: false, roomId });
    };
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
  }, [mx, roomId, ownerId, revision]);

  return { page: state.page, loading: state.loading };
}
