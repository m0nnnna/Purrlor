import { useEffect, useState } from 'react';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useAtomValue } from 'jotai';
import { profileRevisionAtom } from '../../app/state/feed';
import { useMatrixClient } from '../MatrixClientContext';
import { PROFILE_PAGE_EVENT, type ProfilePage } from '../profilePage';
import { readProfilePage } from '../profilePageStore';
import { isRemoteUser } from '../homeServer';
import { ensurePeerRoomReadable, fetchPeers, peerOf } from '../peers';
import { getCached, putCached } from '../deviceCache';

/**
 * Pages as last read, by profile room, so a page visited before is drawn at once while it's read
 * again: in memory for the session, on the device (deviceCache.ts) for a week. `null` is "no
 * page". Someone on another server's kept page is only used while their instance is still an
 * approved peer.
 */
const known = new Map<string, ProfilePage | null>();
const KEPT_MS = 7 * 24 * 60 * 60_000;
const keptKey = (roomId: string) => `profile-page:${roomId}`;

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
  const [state, setState] = useState<{ page?: ProfilePage; loading: boolean; roomId?: string }>(() =>
    roomId && known.has(roomId) ? { page: known.get(roomId) ?? undefined, loading: false, roomId } : { loading: !!roomId }
  );

  useEffect(() => {
    if (!roomId) {
      setState({ loading: false });
      return undefined;
    }
    let cancelled = false;
    let answered = false;
    const remoteOwner = ownerId && isRemoteUser(ownerId) ? ownerId : undefined;
    const load = async () => {
      // Someone on another server: only through an approved peer (peers.ts).
      const allowed = !remoteOwner || (await ensurePeerRoomReadable(mx, remoteOwner, roomId));
      const page = allowed ? await readProfilePage(mx, roomId) : undefined;
      answered = true;
      known.set(roomId, page ?? null);
      void putCached(keptKey(roomId), page ?? null, KEPT_MS);
      if (!cancelled) setState({ page, loading: false, roomId });
    };
    const inMemory = known.has(roomId);
    setState((current) =>
      current.roomId === roomId ? current : inMemory ? { page: known.get(roomId) ?? undefined, loading: false, roomId } : { loading: true, roomId }
    );
    if (!inMemory) {
      void (async () => {
        const kept = await getCached<ProfilePage | null>(keptKey(roomId));
        if (kept === undefined || cancelled || answered) return;
        if (remoteOwner && !peerOf(remoteOwner, await fetchPeers())) return;
        if (!cancelled && !answered) setState({ page: kept ?? undefined, loading: false, roomId });
      })();
    }
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
