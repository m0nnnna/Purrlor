import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { formatLength, formatViews, type WatchVideo } from '../../matrix/videos';
import { formatPostTime } from '../feed/formatPostTime';
import './Watch.css';

/** A video's picture, with its length in the corner. Signed out, the thumbnail is a public media path rather than an mxc address. */
export function VideoThumb({ video, width = 320 }: { video: Pick<WatchVideo, 'thumbnail' | 'duration' | 'visibility'>; width?: number }) {
  const isMxc = video.thumbnail.startsWith('mxc://');
  const resolved = useMediaUrl(isMxc ? video.thumbnail : null, { width, height: Math.round((width * 9) / 16) });
  const src = isMxc ? resolved : video.thumbnail;
  return (
    <span className="nu-watch-thumb" data-nu-role="video-thumb">
      {src && <img src={src} alt="" loading="lazy" />}
      <span className="nu-watch-thumb__length" data-nu-role="video-length">
        {formatLength(video.duration)}
      </span>
      {video.visibility === 'private' && (
        <span className="nu-watch-thumb__private" title="Only people who are signed in can watch this" data-nu-role="video-private">
          <Icon name="lock" size={12} /> Private
        </span>
      )}
    </span>
  );
}

function ChannelLine({ owner }: { owner: string }) {
  const profile = useUserProfile(owner);
  return (
    <span className="nu-watch-card__channel" data-nu-role="video-card-channel">
      <Avatar name={profile.name} mxcUrl={profile.avatarUrl} size={20} />
      {profile.name}
    </span>
  );
}

export function videoMeta(video: Pick<WatchVideo, 'views' | 'uploadedAt'>): string {
  return [formatViews(video.views), formatPostTime(video.uploadedAt)].filter(Boolean).join(' · ');
}

/**
 * A video in a grid: picture, title, channel, views and age. Opens with `onOpen` (signed in) or
 * follows `href` (the public web). `actions` is the owner's edit and delete.
 */
export function VideoCard({
  video,
  onOpen,
  href,
  showChannel = true,
  actions,
}: {
  video: WatchVideo;
  onOpen?: () => void;
  href?: string;
  showChannel?: boolean;
  actions?: ReactNode;
}) {
  const body = (
    <>
      <VideoThumb video={video} />
      <span className="nu-watch-card__title" data-nu-role="video-card-title">
        {video.title}
      </span>
    </>
  );
  return (
    <article className="nu-watch-card" data-nu-role="video-card" data-nu-video={video.id}>
      {href ? (
        <a className="nu-watch-card__open" href={href} data-nu-role="video-card-open">
          {body}
        </a>
      ) : (
        <button type="button" className="nu-watch-card__open" data-nu-role="video-card-open" onClick={onOpen}>
          {body}
        </button>
      )}
      {showChannel && <ChannelLine owner={video.owner} />}
      <span className="nu-watch-card__meta" data-nu-role="video-card-meta">
        {videoMeta(video)}
      </span>
      {actions}
    </article>
  );
}
