import { useEffect } from 'react';
import { ClientEvent, EventType, RoomEvent, RoomStateEvent, type MatrixEvent } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { NOTIFICATION_SETTINGS_ACCOUNT_DATA, syncNotificationRules } from '../../matrix/notificationSettings';
import { syncPostNotificationRules } from '../../matrix/postNotifications';
import { refreshBackgroundPush } from '../../matrix/push';

/** Account data that changes which rules should exist: your feed rooms, and the settings. */
const WATCHED = new Set([
  'xyz.nekous.feed_rooms',
  'xyz.nekous.profile_room',
  'xyz.nekous.post_notifications',
  NOTIFICATION_SETTINGS_ACCOUNT_DATA,
]);

/**
 * Keeps the push rules this app manages in step with what they're worked out from: your
 * like/comment rules with the feeds you own (matrix/postNotifications.ts), and your channel and
 * Space notification levels with the channels you're in (matrix/notificationSettings.ts). Runs
 * once at start, then whenever the settings or your feeds change — including from another
 * device, since both live in account data — and when a Space gains a channel or you join a room,
 * so a new channel in a Space set to "Only @mentions" starts out that way. Also re-registers
 * background push once per start (matrix/push.ts, refreshBackgroundPush). Headless, mounted once
 * in AppShell.
 */
export function NotificationRules() {
  const mx = useMatrixClient();

  useEffect(() => {
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (running) {
        again = true; // one more pass once this one finishes, rather than two racing each other
        return;
      }
      running = true;
      try {
        await syncPostNotificationRules(mx);
      } catch (err) {
        console.warn('Couldn’t update post notification rules', err);
      }
      try {
        await syncNotificationRules(mx);
      } catch (err) {
        console.warn('Couldn’t update channel notification rules', err);
      } finally {
        running = false;
        if (again) {
          again = false;
          void run();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 1000);
    };
    const onAccountData = (event: MatrixEvent) => {
      if (WATCHED.has(event.getType())) schedule();
    };
    const onStateEvent = (event: MatrixEvent) => {
      if (event.getType() === EventType.SpaceChild) schedule();
    };
    const onMembership = (_room: unknown, membership: string) => {
      if (membership === 'join') schedule();
    };

    schedule();
    mx.on(ClientEvent.AccountData, onAccountData);
    mx.on(RoomStateEvent.Events, onStateEvent);
    mx.on(RoomEvent.MyMembership, onMembership);
    // Once per start: re-register this browser with the push gateway (see refreshBackgroundPush).
    refreshBackgroundPush(mx).catch((err: unknown) => console.warn('Couldn’t refresh background push', err));
    return () => {
      clearTimeout(timer);
      mx.removeListener(ClientEvent.AccountData, onAccountData);
      mx.removeListener(RoomStateEvent.Events, onStateEvent);
      mx.removeListener(RoomEvent.MyMembership, onMembership);
    };
  }, [mx]);

  return null;
}
