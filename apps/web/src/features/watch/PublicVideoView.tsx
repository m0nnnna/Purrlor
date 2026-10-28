import { useEffect, useState } from 'react';
import { getHomeServer } from '../../matrix/homeServer';
import { publicPagePath } from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { fetchPublicVideo, formatViews, type WatchVideo } from '../../matrix/videos';
import { formatPostTime } from '../feed/formatPostTime';
import { userIdFromPath } from '../streaming/PublicStreamView';
import { useStreamBase } from '../streaming/useStream';
import { VideoDescription } from './VideoPage';
import { VideoPlayer } from './VideoPlayer';
import './Watch.css';

/**
 * The video page (`/@name/video/<id>`) for someone who isn't signed in: the player, the title,
 * views, age, description and the channel's link. The public API lists no comments, so a visitor
 * is invited to sign in to read and join them. Only public videos are here (the route answers 404
 * for anything else, and the page says so without saying which).
 */
export function PublicVideoView({ user, videoId, onSignIn }: { user: string; videoId: string; onSignIn: () => void }) {
  const owner = userIdFromPath(user);
  const base = useStreamBase(owner, getHomeServer());
  const [state, setState] = useState<{ status: 'loading' } | { status: 'found'; video: WatchVideo } | { status: 'missing' }>({ status: 'loading' });
  const [views, setViews] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchPublicVideo(user, videoId)
      .then((video) => {
        if (cancelled) return;
        setState(video ? { status: 'found', video } : { status: 'missing' });
        setViews(video?.views);
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [user, videoId]);

  const video = state.status === 'found' ? state.video : undefined;
  useEffect(() => {
    if (!video) return undefined;
    const previous = document.title;
    document.title = `${video.title} · Purrlor`;
    return () => {
      document.title = previous;
    };
  }, [video]);

  if (!video) {
    return (
      <main className="nu-public__page nu-watch-public" data-nu-role="public-video">
        <p className="nu-feed__status" data-nu-role="video-missing">
          {state.status === 'loading' ? 'Loading the video…' : 'This video isn’t available.'}
        </p>
      </main>
    );
  }
  return (
    <main className="nu-public__page nu-watch-public" data-nu-role="public-video">
      <div className="nu-watch-page" data-nu-role="video-page" data-nu-video={video.id}>
        <VideoPlayer base={base} video={video} onViews={setViews} />
        <h1 className="nu-watch-page__title" data-nu-role="video-title">
          {video.title}
        </h1>
        <p className="nu-watch-page__meta" data-nu-role="video-meta">
          {[formatViews(views), formatPostTime(video.uploadedAt)].filter(Boolean).join(' · ')}
        </p>
        <div className="nu-watch-page__bar">
          <a className="nu-watch-page__channel" href={publicPagePath(video.owner)} data-nu-role="video-channel">
            <span>{handleFor(video.owner)}</span>
          </a>
        </div>
        <VideoDescription text={video.description} />
        <p className="nu-watch-page__signin" data-nu-role="video-comments-signin">
          <button type="button" className="nu-home__link" onClick={onSignIn}>
            Sign in
          </button>{' '}
          to read and join the comments.
        </p>
      </div>
    </main>
  );
}
