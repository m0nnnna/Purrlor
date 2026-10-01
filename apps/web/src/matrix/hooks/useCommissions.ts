import { useCallback, useEffect, useState } from 'react';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import {
  COMMISSION_PRICES_EVENT,
  COMMISSION_QUEUE_EVENT,
  COMMISSION_STATUS_EVENT,
  fetchConsents,
  readCommissions,
  type Commissions,
} from '../commissions';

const WATCHED = [COMMISSION_STATUS_EVENT, COMMISSION_PRICES_EVENT, COMMISSION_QUEUE_EVENT];

/**
 * An artist's commission status, price sheet and queue (matrix/commissions.ts), and who has agreed
 * to be named in it. Live for a profile room this client is in (your own included); read once for
 * anyone else's, and again on `reload`.
 */
export function useCommissions(roomId: string | undefined): {
  commissions?: Commissions;
  consents: Map<string, Set<string>>;
  loading: boolean;
  reload: () => void;
} {
  const mx = useMatrixClient();
  const [state, setState] = useState<{ commissions?: Commissions; consents: Map<string, Set<string>>; loading: boolean }>({
    consents: new Map(),
    loading: !!roomId,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!roomId) {
      setState({ consents: new Map(), loading: false });
      return undefined;
    }
    let cancelled = false;
    void Promise.all([readCommissions(mx, roomId), fetchConsents(mx, roomId)]).then(([commissions, consents]) => {
      if (!cancelled) setState({ commissions, consents, loading: false });
    });
    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId && WATCHED.includes(event.getType())) {
        void readCommissions(mx, roomId).then((commissions) => {
          if (!cancelled) setState((current) => ({ ...current, commissions }));
        });
      }
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      cancelled = true;
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx, roomId, tick]);

  return { ...state, reload };
}
