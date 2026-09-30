import { useEffect } from 'react';
import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixEvent, type ReceivedToDeviceMessage, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { enforceAutomod } from '../../matrix/automod';
import { fileIncomingReport, isSpaceModerator, readModerationConfig, REPORT_EVENT } from '../../matrix/reports';
import { findParentSpaceId } from '../../matrix/spaceChildren';

/**
 * A moderator's client's part in moderation (matrix/reports.ts, matrix/automod.ts): files reports
 * that arrive by to-device into the Space's review room, and checks each new message in the
 * Space's channels against its blocked words. For everyone else this does nothing: incoming
 * reports are dropped unless you moderate that Space, and automod skips Spaces you don't
 * moderate. Headless, mounted once in AppShell.
 */
export function ModerationWatcher() {
  const mx = useMatrixClient();

  useEffect(() => {
    const onToDevice = ({ message }: ReceivedToDeviceMessage) => {
      if (message.type !== REPORT_EVENT) return;
      // The sender is the one the homeserver vouches for, as for any event.
      fileIncomingReport(mx, message.sender, message.content).catch((err: unknown) =>
        console.warn('Couldn’t file an incoming report', err)
      );
    };

    const check = (event: MatrixEvent, room: Room) => {
      if (event.getType() !== 'm.room.message') return;
      const spaceId = findParentSpaceId(mx, room.roomId);
      const space = spaceId ? mx.getRoom(spaceId) : null;
      if (!space || readModerationConfig(space).blockedWords.length === 0) return;
      if (!isSpaceModerator(space, mx.getUserId() ?? '')) return;
      enforceAutomod(mx, space, room, event).catch((err: unknown) => console.warn('Automod couldn’t act', err));
    };

    const onTimeline = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
      removed: boolean,
      data: { liveEvent?: boolean }
    ) => {
      // New messages only: automod isn't a sweep through history.
      if (toStartOfTimeline || removed || !room || !data.liveEvent) return;
      if (event.isEncrypted() && !event.getClearContent()) {
        event.once(MatrixEventEvent.Decrypted, () => check(event, room));
        return;
      }
      check(event, room);
    };

    mx.on(ClientEvent.ReceivedToDeviceMessage, onToDevice);
    mx.on(RoomEvent.Timeline, onTimeline);
    return () => {
      mx.removeListener(ClientEvent.ReceivedToDeviceMessage, onToDevice);
      mx.removeListener(RoomEvent.Timeline, onTimeline);
    };
  }, [mx]);

  return null;
}
