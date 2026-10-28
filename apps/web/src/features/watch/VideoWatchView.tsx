import { useEffect, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { profileUserIdAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { fetchChannelVideos, type WatchVideo } from '../../matrix/videos';
import { useStreamBase } from '../streaming/useStream';
import { VideoPage } from './VideoPage';
import { openVideoAtom } from './watchState';

type Found = { status: 'loading' } | { status: 'found'; video: WatchVideo } | { status: 'missing' };

/** A linked video isn't in any list yet: its owner's channel is read from the catalogue until it turns up. */
function useVideo(owner: string | undefined, id: string | undefined, given: WatchVideo | undefined): Found {
  const mx = useMatrixClient();
  const [found, setFound] = useState<Found>(given ? { status: 'found', video: given } : { status: 'loading' });
  useEffect(() => {
    if (given) {
      setFound({ status: 'found', video: given });
      return undefined;
    }
    setFound({ status: 'loading' });
    if (!owner || !id) return undefined;
    let cancelled = false;
    fetchChannelVideos(mx, owner)
      .then((videos) => {
        const video = videos.find((candidate) => candidate.id === id);
        if (!cancelled) setFound(video ? { status: 'found', video } : { status: 'missing' });
      })
      .catch(() => {
        if (!cancelled) setFound({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [mx, owner, id, given]);
  return found;
}

/** Signed in, the video page (`/@name/video/<id>`) in the main pane, over whatever was open. Back closes it. */
export function VideoWatchView() {
  const mx = useMatrixClient();
  const [open, setOpen] = useAtom(openVideoAtom);
  const setProfile = useSetAtom(profileUserIdAtom);
  const base = useStreamBase(open?.owner, mx.getDomain() ?? undefined);
  const found = useVideo(open?.owner, open?.id, open?.video);
  if (!open) return null;

  return (
    <main className="nu-main-pane" data-nu-role="main-pane">
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back nu-main-pane__header-back--always"
          data-nu-role="video-watch-back"
          title="Back"
          aria-label="Back"
          onClick={() => setOpen(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1 className="nu-main-pane__header-name">{found.status === 'found' ? found.video.title : 'Video'}</h1>
      </div>
      <div className="nu-watch-scroll">
        {found.status === 'found' ? (
          <VideoPage
            video={found.video}
            base={base}
            onOwner={() => {
              setOpen(null);
              setProfile(found.video.owner);
            }}
            onOpenVideo={(video) => setOpen({ owner: video.owner, id: video.id, video })}
          />
        ) : (
          <p className="nu-watch-page__missing" data-nu-role="video-missing">
            {found.status === 'loading' ? 'Loading the video…' : 'This video isn’t available.'}
          </p>
        )}
      </div>
    </main>
  );
}
