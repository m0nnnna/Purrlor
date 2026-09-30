import { useEffect, useState } from 'react';
import { ClientEvent, EventType, RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import {
  NOTIFICATION_SETTINGS_ACCOUNT_DATA,
  describeRoomLevel,
  readNotificationSettings,
  type NotificationLevel,
} from '../notificationSettings';

/** Re-renders when anything a level is read from changes: the settings, the push rules (which
 *  arrive as `m.push_rules` account data, and may be changed by another client), or which
 *  channels a Space has. */
function useNotificationVersion(): number {
  const mx = useMatrixClient();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onAccountData = (event: MatrixEvent) => {
      const type = event.getType();
      if (type === NOTIFICATION_SETTINGS_ACCOUNT_DATA || type === EventType.PushRules) bump();
    };
    const onState = (event: MatrixEvent) => {
      if (event.getType() === EventType.SpaceChild) bump();
    };
    mx.on(ClientEvent.AccountData, onAccountData);
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx]);

  return version;
}

/** A channel's or DM's notification level (matrix/notificationSettings.ts, describeRoomLevel). */
export function useRoomNotificationLevel(roomId: string): ReturnType<typeof describeRoomLevel> {
  const mx = useMatrixClient();
  useNotificationVersion();
  return describeRoomLevel(mx, roomId);
}

/** A Space's own level, or undefined for the default. */
export function useSpaceNotificationLevel(spaceId: string): NotificationLevel | undefined {
  const mx = useMatrixClient();
  useNotificationVersion();
  return readNotificationSettings(mx).spaces[spaceId];
}
