import { useEffect, useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { playRefusalText, playVideo, type WatchVideo } from '../../matrix/videos';
import './Watch.css';

type Phase = { name: 'idle' } | { name: 'asking' } | { name: 'playing'; src: string } | { name: 'failed'; message: string };

/**
 * The player. Nothing is asked of the server until play is pressed (a play counts as a view), and
 * then the **owner's** server answers with an address of its own for the file, with ranges, so
 * seeking works: that address, never the mxc, is the `<video>`'s `src`. `base` is that server
 * (`''` is this one). If the file stops loading (the address timed out) it asks once more.
 */
export function VideoPlayer({
  base,
  video,
  mx,
  onViews,
}: {
  base: string | undefined;
  video: WatchVideo;
  mx?: MatrixClient;
  onViews?: (views: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const retried = useRef(false);
  const isMxc = video.thumbnail.startsWith('mxc://');
  const resolved = useMediaUrl(isMxc ? video.thumbnail : null, { width: 1280, height: 720 });
  const poster = isMxc ? resolved : video.thumbnail;

  // Another video: back to its poster.
  useEffect(() => {
    setPhase({ name: 'idle' });
    retried.current = false;
  }, [video.owner, video.id]);

  const start = async () => {
    if (base === undefined) return;
    setPhase({ name: 'asking' });
    try {
      const answer = await playVideo(base, mx, video.owner, video.id);
      onViews?.(answer.views);
      setPhase({ name: 'playing', src: answer.url });
    } catch (err) {
      setPhase({ name: 'failed', message: playRefusalText(err) });
    }
  };

  const onError = () => {
    if (retried.current) {
      setPhase({ name: 'failed', message: 'The video stopped loading. Check your connection and try again.' });
      return;
    }
    retried.current = true;
    void start();
  };

  return (
    <div className="nu-watch-player" data-nu-role="video-player" style={{ aspectRatio: `${video.w} / ${video.h}` }}>
      {phase.name === 'playing' ? (
        <video className="nu-watch-player__video" data-nu-role="video-element" src={phase.src} poster={poster ?? undefined} controls autoPlay playsInline onError={onError} />
      ) : (
        <>
          {poster && <img className="nu-watch-player__poster" src={poster} alt="" />}
          <button
            type="button"
            className="nu-watch-player__play"
            data-nu-role="video-play"
            aria-label={`Play ${video.title}`}
            disabled={phase.name === 'asking' || base === undefined}
            onClick={() => void start()}
          >
            <Icon name="play" size={34} />
          </button>
          {phase.name === 'failed' && (
            <p className="nu-watch-player__error" role="alert" data-nu-role="video-play-error">
              {phase.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
