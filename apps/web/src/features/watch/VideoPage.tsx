import { useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useIgnoredUsers } from '../../matrix/hooks/useIgnoredUsers';
import { usePostInteractions } from '../../matrix/hooks/usePostInteractions';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { formatViews, type WatchVideo } from '../../matrix/videos';
import { CommentThread } from '../feed/CommentThread';
import { ReportDialog } from '../feed/ReportDialog';
import { formatPostTime } from '../feed/formatPostTime';
import { renderMessageText } from '../messaging/renderMessageText';
import { VideoCard } from './VideoCard';
import { VideoPlayer } from './VideoPlayer';
import { useCatalogue } from './useCatalogue';
import './Watch.css';

/** How many of the channel's other videos are shown under a video. */
const MORE_FROM_CHANNEL = 12;

/** A video's description, plain text with its links made clickable. */
export function VideoDescription({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="nu-watch-page__description" data-nu-role="video-description">
      {renderMessageText(text, [])}
    </p>
  );
}

function MoreFromChannel({ video, onOpen }: { video: WatchVideo; onOpen: (video: WatchVideo) => void }) {
  const { videos } = useCatalogue({ owners: [video.owner] });
  const more = videos.filter((other) => other.id !== video.id).slice(0, MORE_FROM_CHANNEL);
  if (more.length === 0) return null;
  return (
    <section className="nu-watch-page__more" data-nu-role="video-more" aria-label="More from this channel">
      <h2 className="nu-home__heading">More from this channel</h2>
      <div className="nu-watch-grid">
        {more.map((other) => (
          <VideoCard key={other.id} video={other} showChannel={false} onOpen={() => onOpen(other)} />
        ))}
      </div>
    </section>
  );
}

/**
 * The video page, signed in: the player (a play asks the owner's server, which counts the view),
 * title, views, age, description, the channel, the comments (the profile-room thread hung off the
 * video's anchor, docs/watch.md), and more from the channel.
 */
export function VideoPage({
  video,
  base,
  onOwner,
  onOpenVideo,
}: {
  video: WatchVideo;
  base: string | undefined;
  onOwner: () => void;
  onOpenVideo: (video: WatchVideo) => void;
}) {
  const mx = useMatrixClient();
  const me = mx.getUserId() ?? '';
  const owner = useUserProfile(video.owner);
  const ignored = useIgnoredUsers();
  const interactions = usePostInteractions(video.roomId, video.anchor, video.owner, video.uploadedAt, { fresh: true });
  const [views, setViews] = useState(video.views);
  const [error, setError] = useState<string>();
  const [reporting, setReporting] = useState<string>();
  useEffect(() => setViews(video.views), [video.owner, video.id, video.views]);

  const comments = interactions.comments.filter((comment) => !ignored.has(comment.sender));
  const liked = !!interactions.myLikeId;
  const like = async () => {
    setError(undefined);
    try {
      await interactions.toggleLike();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t update that like');
    }
  };

  return (
    <div className="nu-watch-page" data-nu-role="video-page" data-nu-video={video.id}>
      <VideoPlayer base={base} video={video} mx={mx} onViews={setViews} />
      <h1 className="nu-watch-page__title" data-nu-role="video-title">
        {video.title}
      </h1>
      <p className="nu-watch-page__meta" data-nu-role="video-meta">
        {[formatViews(views), formatPostTime(video.uploadedAt), video.visibility === 'private' ? 'Private' : ''].filter(Boolean).join(' · ')}
      </p>
      <div className="nu-watch-page__bar">
        <button type="button" className="nu-watch-page__channel" data-nu-role="video-channel" onClick={onOwner}>
          <Avatar name={owner.name} mxcUrl={owner.avatarUrl} size={40} />
          <span>{owner.name}</span>
        </button>
        <button
          type="button"
          className={liked ? 'nu-button nu-button--secondary nu-watch-page__like nu-watch-page__like--on' : 'nu-button nu-button--secondary nu-watch-page__like'}
          data-nu-role="video-like"
          aria-pressed={liked}
          disabled={interactions.busy}
          onClick={() => void like()}
        >
          <Icon name="heart" size={16} /> Like{interactions.likeCount > 0 ? ` ${interactions.likeCount}` : ''}
        </button>
      </div>
      <VideoDescription text={video.description} />
      {error && (
        <p className="nu-field__error" data-nu-role="video-error">
          {error}
        </p>
      )}
      <section className="nu-watch-page__comments" data-nu-role="video-comments" aria-label="Comments">
        <h2 className="nu-home__heading">Comments</h2>
        <CommentThread
          comments={comments}
          isPublic
          canComment
          canRemoveAny={video.owner === me}
          onReport={(commentId) => setReporting(commentId)}
          onAdd={interactions.addComment}
          onDelete={interactions.removeComment}
          hasOlder={!!interactions.older}
          loadingOlder={interactions.loadingOlder}
          onLoadOlder={interactions.loadOlder}
          commentStats={interactions.commentStats}
          onLikeComment={(commentId) => void interactions.toggleCommentLike(commentId).catch(() => setError('Couldn’t update that like'))}
        />
      </section>
      {reporting && <ReportDialog roomId={video.roomId} eventId={reporting} what="comment" ownerId={video.owner} postId={video.anchor} onClose={() => setReporting(undefined)} />}
      <MoreFromChannel video={video} onOpen={onOpenVideo} />
    </div>
  );
}
