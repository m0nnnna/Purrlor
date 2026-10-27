import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { NotificationCountType, type Room } from 'matrix-js-sdk';
import { mobileColumnOpenAtom } from '../../app/state/mobile';
import {
  profileUserIdAtom,
  railSectionAtom,
  selectedRoomIdAtom,
  selectedSpaceIdAtom,
  selectedSpaceViewAtom,
} from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { MAIN_FEED_SNAPSHOT } from '../../matrix/feedSnapshot';
import { filterPosts } from '../../matrix/globalFeed';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { findParentSpaceId } from '../../matrix/spaceChildren';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useGlobalFeed } from '../../matrix/hooks/useGlobalFeed';
import { useLiveVoiceChannels } from '../../matrix/hooks/useLiveVoiceChannels';
import { useSpacelessRooms } from '../../matrix/hooks/useSpacelessRooms';
import { useSpaces } from '../../matrix/hooks/useSpaces';
import { useStories } from '../../matrix/hooks/useStories';
import { listChildRooms } from '../../matrix/hooks/useSpaceRooms';
import { useDirectMessageUnreads, useUnreadSummary } from '../../matrix/hooks/useUnreadCounts';
import { describeRoomLevel } from '../../matrix/notificationSettings';
import type { LiveVoiceChannel } from '../../matrix/liveVoice';
import type { PublicStream } from '../../matrix/liveStream';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { isDemoMode } from '../../demo/demoMode';
import { useJoinVoiceChannel } from '../calendar/useJoinVoiceChannel';
import { NoSpacesYet, useInNoSpace } from '../onboarding/WelcomeGuideHost';
import { GlobalPostList } from '../feed/GlobalPostList';
import { useComposerTargets } from '../feed/useComposerTargets';
import { useOpenSocial } from '../feed/useOpenSocial';
import { StoriesBar } from '../stories/StoriesBar';
import { openStreamAtom } from '../streaming/streamerState';
import { useLiveStreams } from '../streaming/useStream';
import './HomeView.css';

/** Participant avatars shown on a live card before "+N". */
const MAX_AVATARS = 5;
/** Posts from people you follow shown on Home. */
const MAX_POSTS = 6;
/** Unread conversations listed on Home. */
const MAX_UNREAD = 8;

const FEED_SNAPSHOT = { key: MAIN_FEED_SNAPSHOT };

function LiveCard({ channel }: { channel: LiveVoiceChannel }) {
  const mx = useMatrixClient();
  const join = useJoinVoiceChannel();
  const room = mx.getRoom(channel.roomId);
  const shown = channel.participants.slice(0, MAX_AVATARS);
  const more = channel.participants.length - shown.length;
  const count = channel.participants.length;
  return (
    <button
      type="button"
      className="nu-home__live"
      data-nu-role="home-live-channel"
      aria-label={`${channel.name} in ${channel.spaceName}, ${count === 1 ? '1 person' : `${count} people`}${channel.screenSharing ? ', screen sharing' : ''}`}
      onClick={() => join(channel.roomId)}
    >
      <span className="nu-home__live-text">
        <span className="nu-home__live-space">{channel.spaceName}</span>
        <span className="nu-home__live-channel">
          <Icon name="volume" size={15} /> {channel.name}
        </span>
      </span>
      {channel.screenSharing && (
        <span className="nu-home__badge" data-nu-role="home-live-screen-share">
          <Icon name="monitor" size={12} /> Screen share
        </span>
      )}
      <span className="nu-home__avatars">
        {shown.map((p) => {
          const member = room?.getMember(p.identity);
          return (
            <span key={p.identity} className="nu-home__avatar" title={member?.name || p.identity}>
              <Avatar name={member?.name || p.identity} mxcUrl={member?.getMxcAvatarUrl() ?? null} size={26} />
            </span>
          );
        })}
        {more > 0 && <span className="nu-home__more">+{more}</span>}
      </span>
    </button>
  );
}

/** A live stream's thumbnail is replaced this often (the server's newest picture comes about every 60 s). */
const THUMBNAIL_REFRESH_MS = 60_000;

function StreamCard({ stream }: { stream: PublicStream }) {
  const setOpenStream = useSetAtom(openStreamAtom);
  const owner = useUserProfile(stream.owner);
  // A new `?t=` makes the browser fetch the newest picture instead of its cached one.
  const [stamp, setStamp] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setStamp(Date.now()), THUMBNAIL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const watching = stream.viewers === undefined ? '' : stream.viewers === 1 ? '1 watching' : `${stream.viewers} watching`;
  return (
    <button
      type="button"
      className="nu-home__live nu-home__stream"
      data-nu-role="home-live-stream"
      aria-label={`${stream.title}, live from ${owner.name}${watching ? `, ${watching}` : ''}`}
      onClick={() => setOpenStream({ owner: stream.owner, streamId: stream.id })}
    >
      <span className="nu-home__stream-thumb">
        {stream.thumbnail && <img src={`${stream.thumbnail}?t=${stamp}`} alt="" />}
        <span className="nu-home__stream-badges">
          <span className="nu-live-badge">LIVE</span>
          {watching}
        </span>
      </span>
      <span className="nu-home__stream-text">
        <span className="nu-home__stream-title">{stream.title}</span>
      </span>
      <span className="nu-home__stream-owner">
        <Avatar name={owner.name} mxcUrl={owner.avatarUrl} size={22} />
        {owner.name}
      </span>
    </button>
  );
}

function LiveNow({ live, streams }: { live: LiveVoiceChannel[]; streams: PublicStream[] }) {
  if (live.length === 0 && streams.length === 0) return null;
  return (
    <section className="nu-home__section" data-nu-role="home-live" aria-labelledby="nu-home-live">
      <h2 className="nu-home__heading" id="nu-home-live">
        Live now
      </h2>
      <div className="nu-home__live-list">
        {streams.map((stream) => (
          <StreamCard key={stream.id} stream={stream} />
        ))}
        {live.map((channel) => (
          <LiveCard key={channel.roomId} channel={channel} />
        ))}
      </div>
    </section>
  );
}

type UnreadRoom = { room: Room; count: number; mentions: number; direct: boolean };

/** DMs with unread messages, and channels where you were mentioned, most recent first. */
function useUnreadRooms(): UnreadRoom[] {
  const mx = useMatrixClient();
  const userId = mx.getUserId() ?? '';
  const spaces = useSpaces();
  const dms = useSpacelessRooms();
  const channels = spaces.flatMap((space) => listChildRooms(mx, space.roomId));
  // Re-render when any of their counts change.
  useUnreadSummary([...dms, ...channels]);
  const dmCounts = useDirectMessageUnreads(dms, userId, (roomId) => describeRoomLevel(mx, roomId).effective !== 'all');

  const found: UnreadRoom[] = [];
  for (const room of dms) {
    const count = dmCounts.get(room.roomId) ?? 0;
    const mentions = room.getUnreadNotificationCount(NotificationCountType.Highlight);
    if (count > 0 || mentions > 0) found.push({ room, count: Math.max(count, mentions), mentions, direct: true });
  }
  for (const room of channels) {
    const mentions = room.getUnreadNotificationCount(NotificationCountType.Highlight);
    if (mentions > 0) found.push({ room, count: mentions, mentions, direct: false });
  }
  const lastTs = (room: Room) => room.getLastActiveTimestamp();
  return found.sort((a, b) => lastTs(b.room) - lastTs(a.room)).slice(0, MAX_UNREAD);
}

function UnreadMessages({ unread }: { unread: UnreadRoom[] }) {
  const mx = useMatrixClient();
  const setSpaceId = useSetAtom(selectedSpaceIdAtom);
  const setRoomId = useSetAtom(selectedRoomIdAtom);
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setSection = useSetAtom(railSectionAtom);
  const setMobileColumnOpen = useSetAtom(mobileColumnOpenAtom);
  if (unread.length === 0) return null;

  const open = (room: Room) => {
    setMobileColumnOpen(false);
    setProfileUserId(null);
    setSpaceView(null);
    setSpaceId(findParentSpaceId(mx, room.roomId));
    setRoomId(room.roomId);
    setSection('messages');
  };

  return (
    <section className="nu-home__section" data-nu-role="home-unread" aria-labelledby="nu-home-unread">
      <h2 className="nu-home__heading" id="nu-home-unread">
        Unread messages
      </h2>
      <ul className="nu-home__unread-list">
        {unread.map(({ room, count, mentions, direct }) => {
          const parent = direct ? undefined : mx.getRoom(findParentSpaceId(mx, room.roomId) ?? '');
          const mxc = room.getMxcAvatarUrl() ?? (direct ? room.getAvatarFallbackMember()?.getMxcAvatarUrl() : null) ?? null;
          return (
            <li key={room.roomId}>
              <button type="button" className="nu-home__unread" data-nu-role="home-unread-room" onClick={() => open(room)}>
                <Avatar name={room.name} mxcUrl={mxc} size={32} />
                <span className="nu-home__unread-text">
                  <span className="nu-home__unread-name">{direct ? room.name : `# ${room.name}`}</span>
                  {parent && <span className="nu-home__unread-space">{parent.name}</span>}
                </span>
                <span className={mentions > 0 ? 'nu-home__count nu-home__count--mention' : 'nu-home__count'}>{count > 99 ? '99+' : count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Whether the follows section has anything: reported up so Home can tell when everything is empty. */
function useFollowingPosts() {
  const follows = useFollows();
  const followsNothing = follows.users.length === 0 && follows.spaces.length === 0;
  const feed = useGlobalFeed(!followsNothing, follows, { snapshot: FEED_SNAPSHOT });
  const targets = useComposerTargets(feed.publicSpaceIds);
  const posts = followsNothing
    ? []
    : filterPosts(feed.posts, { kind: 'following', users: follows.users, spaces: follows.spaces }).slice(0, MAX_POSTS);
  return { posts, targets, loading: feed.loading, follows };
}

function Following({ posts, targets }: { posts: ReturnType<typeof useFollowingPosts>['posts']; targets: ReturnType<typeof useFollowingPosts>['targets'] }) {
  const openSocial = useOpenSocial();
  if (posts.length === 0) return null;
  return (
    <section className="nu-home__section" data-nu-role="home-following" aria-labelledby="nu-home-following">
      <div className="nu-home__heading-row">
        <h2 className="nu-home__heading" id="nu-home-following">
          From people you follow
        </h2>
        <button type="button" className="nu-home__link" data-nu-role="home-see-all" onClick={() => openSocial('following')}>
          See all in Feed
        </button>
      </div>
      <div className="nu-home__posts">
        <GlobalPostList posts={posts} targets={targets} />
      </div>
    </section>
  );
}

/**
 * The Home dashboard, "Here's what's happening": stories from people you follow, voice channels with people in them, the newest
 * posts from people you follow, and conversations waiting on you. Each section is left out when
 * it's empty, and if all are, a friendly note stands in.
 */
export function HomeView() {
  const following = useFollowingPosts();
  const live = useLiveVoiceChannels(true);
  // Streams live on this server (docs/streaming.md), beside the voice channels.
  const streams = useLiveStreams(isDemoMode() ? undefined : '', true);
  const unread = useUnreadRooms();
  const showStories = !isDemoMode();
  const stories = useStories(showStories, following.follows.users);
  // Someone in no Space yet gets the ways in (joining, creating) rather than a quiet dashboard.
  const noSpaces = useInNoSpace() && !isDemoMode();
  const empty = live.length === 0 && streams.length === 0 && following.posts.length === 0 && unread.length === 0;

  return (
    <main className="nu-main-pane" data-nu-role="main-pane">
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <Icon name="paw" size={20} className="nu-main-pane__header-icon" />
        <h1 className="nu-main-pane__header-name">Home</h1>
      </div>
      <div className="nu-home" data-nu-role="home">
        <h2 className="nu-home__title">Here’s what’s happening</h2>
        {showStories && <StoriesBar stories={stories} />}
        <LiveNow live={live} streams={streams} />
        <Following posts={following.posts} targets={following.targets} />
        <UnreadMessages unread={unread} />
        {empty && noSpaces && <NoSpacesYet />}
        {empty && !noSpaces && (
          <div className="nu-home__empty" data-nu-role="home-empty">
            <Icon name="paw" size={40} className="nu-main-pane__empty-icon" />
            <p className="nu-home__empty-title">{following.loading ? 'Looking around…' : 'All quiet for now'}</p>
            <p className="nu-home__empty-hint">
              Nobody is in a voice channel, there is nothing new from the people you follow, and no messages are waiting. Check back soon, or find
              something to join in Discover.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
