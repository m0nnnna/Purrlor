import { useEffect, useState } from 'react';
import { EventType, RoomStateEvent, type Room } from 'matrix-js-sdk';
import { nameHue } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { SpaceNotificationMenu } from '../notifications/NotificationLevelMenu';

function readSpaceInfo(space: Room) {
  return {
    topic: space.currentState.getStateEvents(EventType.RoomTopic, '')?.getContent<{ topic?: string }>().topic,
    memberCount: space.getJoinedMemberCount(),
  };
}

/**
 * The top of a Space's channel list: who this place is, before what's in it. Matrix Spaces have
 * no banner image of their own, so the banner is the Space's avatar blown up and blurred behind
 * it (or, with no avatar, a gradient from the same stable name-hue avatars use) — every Space
 * gets a distinct header without anyone having to upload a second image.
 */
export function SpaceCard({
  space,
  canManageSpace,
  onOpenSettings,
  onAddExisting,
  onCreateChannel,
}: {
  space: Room;
  canManageSpace: boolean;
  onOpenSettings: () => void;
  onAddExisting: () => void;
  onCreateChannel: () => void;
}) {
  const avatarSrc = useMediaUrl(space.getMxcAvatarUrl(), { width: 160, height: 160, method: 'crop' });
  const [info, setInfo] = useState(() => readSpaceInfo(space));
  const hue = nameHue(space.name || '?');

  useEffect(() => {
    const update = () => setInfo(readSpaceInfo(space));
    update();
    space.on(RoomStateEvent.Events, update);
    return () => {
      space.removeListener(RoomStateEvent.Events, update);
    };
  }, [space]);

  return (
    <header className="nu-space-card" data-nu-role="channel-list-header" style={{ ['--nu-space-hue' as string]: hue }}>
      <div className="nu-space-card__banner" data-nu-role="space-card-banner" aria-hidden="true">
        {avatarSrc && <img className="nu-space-card__banner-image" src={avatarSrc} alt="" />}
      </div>
      <div className="nu-space-card__top">
        <div className="nu-space-card__icon" data-nu-role="space-card-icon">
          {avatarSrc ? <img src={avatarSrc} alt="" /> : (space.name || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="nu-space-card__actions">
          <button
            type="button"
            className="nu-space-card__action"
            data-nu-role="channel-list-settings"
            title="Space settings"
            aria-label="Space settings"
            onClick={onOpenSettings}
          >
            <Icon name="settings" size={16} />
          </button>
          {canManageSpace && (
            <button
              type="button"
              className="nu-space-card__action"
              data-nu-role="channel-list-add-existing"
              title="Add an existing channel"
              aria-label="Add an existing channel"
              onClick={onAddExisting}
            >
              <Icon name="link" size={16} />
            </button>
          )}
          <button
            type="button"
            className="nu-space-card__action"
            data-nu-role="channel-list-add"
            title="Create channel"
            aria-label="Create channel"
            onClick={onCreateChannel}
          >
            <Icon name="plus" size={16} />
          </button>
          <SpaceNotificationMenu spaceId={space.roomId} triggerClassName="nu-space-card__action" />
        </div>
      </div>
      <h2 className="nu-space-card__name" data-nu-role="space-card-name">
        {space.name}
      </h2>
      {info.topic && (
        <p className="nu-space-card__topic" data-nu-role="space-card-topic" title={info.topic}>
          {info.topic}
        </p>
      )}
      <div className="nu-space-card__meta">
        <Icon name="users" size={13} />
        {info.memberCount} {info.memberCount === 1 ? 'member' : 'members'}
      </div>
    </header>
  );
}
