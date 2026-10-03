import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { unreadActivityCountAtom } from '../../app/state/feed';
import type { Room } from 'matrix-js-sdk';
import {
  globalFeedOpenAtom,
  profileUserIdAtom,
  selectedRoomIdAtom,
  selectedSpaceIdAtom,
  selectedSpaceViewAtom,
  socialViewAtom,
} from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { UnreadBadge } from '../../components/UnreadBadge';
import { DiscoverModal } from '../discover/DiscoverModal';
import { InvitesModal } from '../invites/InvitesModal';
import { useOpenSocial } from '../feed/useOpenSocial';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useInvites } from '../../matrix/hooks/useInvites';
import { useSpaceRooms } from '../../matrix/hooks/useSpaceRooms';
import { useSpacelessRooms } from '../../matrix/hooks/useSpacelessRooms';
import { useSpaces } from '../../matrix/hooks/useSpaces';
import { useDirectMessageUnreads, useUnreadSummary } from '../../matrix/hooks/useUnreadCounts';
import { describeRoomLevel } from '../../matrix/notificationSettings';
import { classifyInvite, parentSpaceOf } from '../../matrix/invites';
import { getParentSpace } from '../../matrix/voice';
import { CreateSpaceModal } from './CreateSpaceModal';
import { locateInList, usePointerDrag } from '../../components/usePointerDrag';
import { moveSpace } from '../../matrix/spaceOrder';
import './ServerRail.css';

/** The selected tile's cat ears — drawn on every tile, shown only on the active one (CSS),
 *  so selecting a space animates them in rather than mounting a new element. */
function CatEars() {
  return (
    <svg className="nu-server-rail__ears" viewBox="0 0 48 14" aria-hidden="true" focusable="false">
      <path className="nu-server-rail__ear" d="M4 14 9.5 1.5 19 14z" />
      <path className="nu-server-rail__ear-inner" d="M8.5 14 10.3 7.5 14.6 14z" />
      <path className="nu-server-rail__ear" d="M29 14 38.5 1.5 44 14z" />
      <path className="nu-server-rail__ear-inner" d="M33.4 14 37.7 7.5 39.5 14z" />
    </svg>
  );
}

/** A Space's tile can be dragged to another place in the rail (usePointerDrag, matrix/spaceOrder.ts). */
type TileDrag = { dragging: boolean; clickAllowed: () => boolean; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void };

function ServerRailItem({ space, active, onSelect, drag }: { space: Room; active: boolean; onSelect: () => void; drag?: TileDrag }) {
  const src = useMediaUrl(space.getMxcAvatarUrl(), { width: 96, height: 96, method: 'crop' });
  const unread = useUnreadSummary(useSpaceRooms(space.roomId));

  const className = [
    'nu-server-rail__item',
    active && 'nu-server-rail__item--active',
    unread.total > 0 && 'nu-server-rail__item--unread',
    drag && 'nu-server-rail__item--draggable',
    drag?.dragging && 'nu-server-rail__item--dragging',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      data-nu-role="server-rail-item"
      title={space.name}
      aria-label={space.name}
      aria-current={active ? 'page' : undefined}
      data-nu-drag-space={space.roomId}
      onPointerDown={drag?.onPointerDown}
      onClick={() => {
        if (!drag || drag.clickAllowed()) onSelect();
      }}
    >
      <CatEars />
      {src ? (
        <img className="nu-server-rail__item-image" src={src} alt="" />
      ) : (
        (space.name || '?').slice(0, 1).toUpperCase()
      )}
      <span className="nu-server-rail__item-badge">
        <UnreadBadge total={unread.total} highlight={unread.highlight} />
      </span>
    </button>
  );
}

/** How many unread DMs get their own tile under Home; the rest are in Home's count. */
const MAX_DM_TILES = 3;

/** An unread DM in the rail, under Home: who it's with, and how many messages, one click away. */
function DirectMessageRailItem({ room, count, onSelect }: { room: Room; count: number; onSelect: () => void }) {
  const mxc = room.getMxcAvatarUrl() ?? room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
  const src = useMediaUrl(mxc, { width: 96, height: 96, method: 'crop' });
  const label = `${room.name}, ${count === 1 ? '1 unread message' : `${count > 99 ? '99+' : count} unread messages`}`;
  return (
    <button
      type="button"
      className="nu-server-rail__item nu-server-rail__item--dm nu-server-rail__item--unread"
      data-nu-role="server-rail-dm"
      title={label}
      aria-label={label}
      onClick={onSelect}
    >
      {src ? <img className="nu-server-rail__item-image" src={src} alt="" /> : (room.name || '?').slice(0, 1).toUpperCase()}
      <span className="nu-server-rail__item-badge">
        <UnreadBadge total={count} highlight={count} />
      </span>
    </button>
  );
}

/** Left icon rail — one icon per joined Matrix Space, mapped to a Discord "server". */
export function ServerRail() {
  const mx = useMatrixClient();
  const storedSpaces = useSpaces();
  // Dragging a Space to another place (matrix/spaceOrder.ts): shown at once, saved behind it.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const storedIds = storedSpaces.map((space) => space.roomId).join('\n');
  useEffect(() => {
    if (!pendingOrder) return undefined;
    if (pendingOrder.join('\n') === storedIds) {
      setPendingOrder(null);
      return undefined;
    }
    const timer = setTimeout(() => setPendingOrder(null), 20_000);
    return () => clearTimeout(timer);
  }, [pendingOrder, storedIds]);
  const spaces = pendingOrder
    ? [
        ...pendingOrder.flatMap((id) => storedSpaces.filter((space) => space.roomId === id)),
        ...storedSpaces.filter((space) => !pendingOrder.includes(space.roomId)),
      ]
    : storedSpaces;
  const listRef = useRef<HTMLDivElement>(null);
  const spaceDrag = usePointerDrag<{ id: string; label: string }, number>({
    containerRef: listRef,
    enabled: true,
    locate: (item, clientY, container) => locateInList(container, 'data-nu-drag-space', item.id, clientY),
    drop: (item, index) => {
      const from = spaces.findIndex((space) => space.roomId === item.id);
      const ids = spaces.map((space) => space.roomId).filter((id) => id !== item.id);
      const at = Math.max(0, Math.min(from < index ? index - 1 : index, ids.length));
      const next = [...ids.slice(0, at), item.id, ...ids.slice(at)];
      if (next.join('\n') === spaces.map((space) => space.roomId).join('\n')) return;
      const before = spaces;
      setPendingOrder(next);
      moveSpace(mx, before, item.id, index).catch((err: unknown) => {
        console.error('Moving a Space failed', err);
        setPendingOrder(null);
      });
    },
  });
  const invites = useInvites();
  const [selectedSpaceId, setSelectedSpaceId] = useAtom(selectedSpaceIdAtom);
  const [, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [globalFeedOpen, setGlobalFeedOpen] = useAtom(globalFeedOpenAtom);
  const socialView = useAtomValue(socialViewAtom);
  const unreadNotifications = useAtomValue(unreadActivityCountAtom);
  const openSocial = useOpenSocial();
  const onNotifications = globalFeedOpen && socialView === 'notifications';
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const spacelessRooms = useSpacelessRooms();
  const dmUnread = useUnreadSummary(spacelessRooms);
  // Every unread message in a DM counts, as a mention does in a channel (useDirectMessageUnreads);
  // DMs set to "Only @mentions" or muted keep to the server's counts above.
  const dmCounts = useDirectMessageUnreads(spacelessRooms, mx.getUserId() ?? '', (roomId) => describeRoomLevel(mx, roomId).effective !== 'all');
  const dmCountTotal = [...dmCounts.values()].reduce((sum, n) => sum + n, 0) + dmUnread.highlight;
  const unreadDms = spacelessRooms.filter((room) => dmCounts.has(room.roomId)).slice(0, MAX_DM_TILES);

  // A Space opens fresh, with nothing chosen in it: ChannelList then lands on its unseen news or its
  // first text channel (matrix/spaceNews.ts), rather than whatever view the last Space was on.
  const selectSpace = (id: string | null) => {
    setGlobalFeedOpen(false);
    setProfileUserId(null);
    setSelectedSpaceId(id);
    setSelectedRoomId(null);
    setSpaceView(null);
  };

  const openDirectMessage = (roomId: string) => {
    setGlobalFeedOpen(false);
    setProfileUserId(null);
    setSpaceView(null);
    setSelectedSpaceId(null);
    setSelectedRoomId(roomId);
  };

  const handleInviteAccepted = (room: Room) => {
    const kind = classifyInvite(mx, room);
    if (kind === 'space') {
      selectSpace(room.roomId);
    } else if (kind === 'channel') {
      const parentId = getParentSpace(mx, room)?.roomId ?? parentSpaceOf(room)?.roomId ?? null;
      setSelectedSpaceId(parentId);
      setSelectedRoomId(room.roomId);
    } else {
      setSelectedSpaceId(null);
      setSelectedRoomId(room.roomId);
    }
  };

  return (
    <nav className="nu-server-rail" data-nu-role="server-rail">
      <button
        type="button"
        className={
          [
            'nu-server-rail__item',
            'nu-server-rail__item--home',
            selectedSpaceId === null && !globalFeedOpen && 'nu-server-rail__item--active',
            (dmCountTotal > 0 || dmUnread.total > 0) && 'nu-server-rail__item--unread',
          ]
            .filter(Boolean)
            .join(' ')
        }
        data-nu-role="server-rail-home"
        title="Direct Messages"
        aria-label={dmCountTotal > 0 ? `Direct Messages, ${dmCountTotal} unread` : 'Direct Messages'}
        onClick={() => selectSpace(null)}
      >
        <CatEars />
        <Icon name="paw" size={24} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={dmCountTotal || dmUnread.total} highlight={dmCountTotal} />
        </span>
      </button>
      {unreadDms.map((room) => (
        <DirectMessageRailItem
          key={room.roomId}
          room={room}
          count={dmCounts.get(room.roomId) ?? 0}
          onSelect={() => openDirectMessage(room.roomId)}
        />
      ))}
      <button
        type="button"
        className={
          globalFeedOpen && !onNotifications
            ? 'nu-server-rail__item nu-server-rail__item--global-feed nu-server-rail__item--active'
            : 'nu-server-rail__item nu-server-rail__item--global-feed'
        }
        data-nu-role="server-rail-global-feed"
        title="Global feed"
        aria-label="Global feed"
        aria-current={globalFeedOpen && !onNotifications ? 'page' : undefined}
        onClick={() => openSocial(socialView === 'notifications' ? 'everyone' : socialView)}
      >
        <CatEars />
        <Icon name="globe" size={22} />
      </button>
      <div className="nu-server-rail__divider" />
      <div
        className={spaceDrag.dragging ? 'nu-server-rail__list nu-server-rail__list--dragging' : 'nu-server-rail__list'}
        data-nu-role="server-rail-list"
        ref={listRef}
      >
        {spaceDrag.lineTop !== null && <div className="nu-server-rail__drop-line" style={{ top: spaceDrag.lineTop }} aria-hidden="true" />}
        {spaces.map((space) => (
          <ServerRailItem
            key={space.roomId}
            drag={{
              dragging: spaceDrag.dragging?.id === space.roomId,
              clickAllowed: spaceDrag.clickAllowed,
              onPointerDown: (event) => spaceDrag.start({ id: space.roomId, label: space.name }, event),
            }}
            space={space}
            active={selectedSpaceId === space.roomId && !globalFeedOpen}
            onSelect={() => selectSpace(space.roomId)}
          />
        ))}
      </div>
      {spaceDrag.dragging && spaceDrag.pointer && (
        <div className="nu-server-rail__drag-label" style={{ left: spaceDrag.pointer.x + 14, top: spaceDrag.pointer.y + 14 }} aria-hidden="true">
          {spaceDrag.dragging.label}
        </div>
      )}
      <div className="nu-server-rail__divider" />
      {/* Everything that's about you, in one place: mentions anywhere, and what people did with
          your posts and profile (the social side's Notifications page). */}
      <button
        type="button"
        className={
          onNotifications
            ? 'nu-server-rail__item nu-server-rail__item--notifications nu-server-rail__item--active'
            : 'nu-server-rail__item nu-server-rail__item--notifications'
        }
        data-nu-role="server-rail-notifications"
        title="Notifications"
        aria-label={unreadNotifications > 0 ? `Notifications, ${unreadNotifications} new` : 'Notifications'}
        aria-current={onNotifications ? 'page' : undefined}
        onClick={() => openSocial('notifications')}
      >
        <Icon name="bell" size={20} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={unreadNotifications} highlight={unreadNotifications} />
        </span>
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--invites"
        data-nu-role="server-rail-invites"
        title="Invites"
        aria-label="Invites"
        onClick={() => setShowInvites(true)}
      >
        <Icon name="mail" size={20} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={invites.length} highlight={invites.length} />
        </span>
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--discover"
        data-nu-role="server-rail-discover"
        title="Discover public spaces and channels"
        aria-label="Discover"
        onClick={() => setShowDiscover(true)}
      >
        <Icon name="compass" size={20} />
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--add"
        data-nu-role="server-rail-add"
        title="Create a Space"
        aria-label="Create a Space"
        onClick={() => setShowCreateSpace(true)}
      >
        <Icon name="plus" size={20} />
      </button>
      {showCreateSpace && (
        <CreateSpaceModal
          onClose={() => setShowCreateSpace(false)}
          onCreated={(roomId) => {
            setShowCreateSpace(false);
            selectSpace(roomId);
          }}
        />
      )}
      {showDiscover && (
        <DiscoverModal
          onClose={() => setShowDiscover(false)}
          onJoinedSpace={(roomId) => selectSpace(roomId)}
        />
      )}
      {showInvites && (
        <InvitesModal
          onClose={() => setShowInvites(false)}
          onAccepted={(room) => {
            setShowInvites(false);
            handleInviteAccepted(room);
          }}
        />
      )}
    </nav>
  );
}
