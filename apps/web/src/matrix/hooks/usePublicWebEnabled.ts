import { useEffect, useState } from 'react';
import { RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { PUBLIC_WEB_EVENT, readPublicWebEnabled } from '../publicWebSwitch';

/** Whether your page is shown to people who aren't signed in (matrix/publicWebSwitch.ts), live. */
export function usePublicWebEnabled(): boolean {
  const mx = useMatrixClient();
  const [enabled, setEnabled] = useState(() => readPublicWebEnabled(mx));
  useEffect(() => {
    setEnabled(readPublicWebEnabled(mx));
    const onState = (event: MatrixEvent) => {
      if (event.getType() === PUBLIC_WEB_EVENT) setEnabled(readPublicWebEnabled(mx));
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx]);
  return enabled;
}
