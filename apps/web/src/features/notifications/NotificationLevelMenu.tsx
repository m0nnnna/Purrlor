import { Icon, type IconName } from '../../components/Icon';
import { Menu, MenuItem } from '../../components/Menu';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useRoomNotificationLevel, useSpaceNotificationLevel } from '../../matrix/hooks/useNotificationLevel';
import { setRoomNotificationLevel, setSpaceNotificationLevel, type NotificationLevel } from '../../matrix/notificationSettings';
import { findParentSpaceId } from '../../matrix/spaceChildren';
import './NotificationLevelMenu.css';

export const LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: 'All messages',
  mentions: 'Only @mentions',
  nothing: 'Nothing',
};

const LEVEL_ICONS: Record<NotificationLevel, IconName> = { all: 'bell', mentions: 'at', nothing: 'bellOff' };

/** One choice in the list, with a check on the current one. */
function LevelItem({ label, checked, role, onSelect }: { label: string; checked: boolean; role: string; onSelect: () => void }) {
  return (
    <MenuItem role={role} onSelect={onSelect}>
      <span className="nu-notification-menu__check" aria-hidden="true">
        {checked && <Icon name="check" size={14} />}
      </span>
      {label}
      {checked && <span className="nu-notification-menu__hidden"> (current)</span>}
    </MenuItem>
  );
}

function report(err: unknown) {
  console.warn('Couldn’t change notification settings', err);
}

/**
 * A channel's or DM's notification level (matrix/notificationSettings.ts): the bell on its row.
 * A channel in a Space can follow the Space; a level of its own beats it. Anywhere else, "All
 * messages" is the default and clears any level. The trigger shows the level it's at, so a
 * channel that's quiet says so without opening the menu.
 */
export function RoomNotificationMenu({ roomId, triggerClassName }: { roomId: string; triggerClassName: string }) {
  const mx = useMatrixClient();
  const { own, fromSpace, effective } = useRoomNotificationLevel(roomId);
  const inSpace = findParentSpaceId(mx, roomId) !== null;
  const set = (level: NotificationLevel | undefined) => void setRoomNotificationLevel(mx, roomId, level).catch(report);

  // Which item is checked. With no level here, the Space's (when it has one) or, outside a
  // Space, "All messages". A room another client made quieter shows that level instead.
  const shown: NotificationLevel | 'inherit' =
    own ?? (fromSpace || (effective === 'all' && inSpace) ? 'inherit' : effective);

  return (
    <Menu
      label={`Notifications: ${LEVEL_LABELS[effective]}`}
      trigger={<Icon name={LEVEL_ICONS[effective]} size={13} />}
      triggerClassName={triggerClassName}
      role="room-notification-menu"
      align="end"
    >
      {inSpace && (
        <LevelItem
          label={`Use Space setting (${LEVEL_LABELS[fromSpace ?? 'all']})`}
          checked={shown === 'inherit'}
          role="room-notification-inherit"
          onSelect={() => set(undefined)}
        />
      )}
      {(Object.keys(LEVEL_LABELS) as NotificationLevel[]).map((level) => (
        <LevelItem
          key={level}
          label={LEVEL_LABELS[level]}
          checked={shown === level}
          role={`room-notification-${level}`}
          onSelect={() => set(!inSpace && level === 'all' ? undefined : level)}
        />
      ))}
    </Menu>
  );
}

/** A Space's level for all its channels, in the Space's header. "All messages" is the default. */
export function SpaceNotificationMenu({ spaceId, triggerClassName }: { spaceId: string; triggerClassName: string }) {
  const mx = useMatrixClient();
  const current = useSpaceNotificationLevel(spaceId) ?? 'all';
  const set = (level: NotificationLevel) =>
    void setSpaceNotificationLevel(mx, spaceId, level === 'all' ? undefined : level).catch(report);

  return (
    <Menu
      label={`Space notifications: ${LEVEL_LABELS[current]}`}
      trigger={<Icon name={LEVEL_ICONS[current]} size={15} />}
      triggerClassName={triggerClassName}
      role="space-notification-menu"
      align="end"
    >
      {(Object.keys(LEVEL_LABELS) as NotificationLevel[]).map((level) => (
        <LevelItem
          key={level}
          label={LEVEL_LABELS[level]}
          checked={current === level}
          role={`space-notification-${level}`}
          onSelect={() => set(level)}
        />
      ))}
    </Menu>
  );
}
