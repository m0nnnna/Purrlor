import { useContext, useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { mapWithConcurrency } from '../../matrix/globalFeed';
import { publicPagePath } from '../../matrix/publicWeb';
import type { PageBlock } from '../../matrix/profilePage';
import { fetchChannelVideos, fetchPublicVideo, videoPath, type WatchVideo } from '../../matrix/videos';
import { VideoCard } from '../watch/VideoCard';
import { openVideoAtom } from '../watch/watchState';
import { PageOwnerContext } from '../profilePage/PageOwnerContext';
import '../watch/Watch.css';

type Block = Extract<PageBlock, { type: 'videos' }>;

/** Videos shown per playlist before "Show all". */
const SHOWN = 12;

/** The owner's videos by id: signed in, from the catalogue's channel (private ones too); signed out, one public route per id. */
function useBlockVideos(owner: string | undefined, ids: string[]): Map<string, WatchVideo> | undefined {
  const mx = useContext(MatrixClientContext);
  const [found, setFound] = useState<Map<string, WatchVideo>>();
  const key = ids.join(',');
  useEffect(() => {
    if (!owner) return undefined;
    let cancelled = false;
    const done = (videos: WatchVideo[]) => {
      if (!cancelled) setFound(new Map(videos.map((video) => [video.id, video])));
    };
    if (mx) {
      fetchChannelVideos(mx, owner).then(done, () => done([]));
    } else {
      void mapWithConcurrency(ids, 4, (id) => fetchPublicVideo(owner, id).catch(() => undefined)).then((videos) => done(videos.filter((video): video is WatchVideo => !!video)));
    }
    return () => {
      cancelled = true;
    };
    // The ids' contents, not the array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, owner, key]);
  return found;
}

/**
 * A page's videos block: the owner's playlists, each a row of video cards. An id whose video is
 * gone (or private, to someone signed out) is skipped; a playlist with nothing left is hidden.
 */
export function VideosBlock({ block }: { block: Block }) {
  const owner = useContext(PageOwnerContext);
  const mx = useContext(MatrixClientContext);
  const setOpenVideo = useSetAtom(openVideoAtom);
  const [all, setAll] = useState<Set<string>>(new Set());
  // Signed out, only the first few per playlist are asked for.
  const wanted = [...new Set(block.playlists.flatMap((list) => (mx ? list.videoIds : list.videoIds.slice(0, SHOWN))))];
  const videos = useBlockVideos(owner?.userId, wanted);
  if (!videos) return <p className="nu-feed__status">Loading videos…</p>;
  const lists = block.playlists
    .map((list) => ({ ...list, videos: list.videoIds.flatMap((id) => videos.get(id) ?? []) }))
    .filter((list) => list.videos.length > 0);
  if (lists.length === 0) return <p className="nu-feed__status" data-nu-role="videos-block-empty">No videos to show yet.</p>;

  return (
    <div className="nu-profile-page__videos" data-nu-role="profile-page-videos">
      {lists.map((list) => {
        const open = all.has(list.id);
        const shown = open ? list.videos : list.videos.slice(0, SHOWN);
        return (
          <section key={list.id} className="nu-profile-page__playlist" data-nu-role="profile-page-playlist">
            {(list.title || lists.length > 1) && <h4 className="nu-profile-page__playlist-title">{list.title ?? 'Videos'}</h4>}
            <div className="nu-watch-grid">
              {shown.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  showChannel={false}
                  {...(mx ? { onOpen: () => setOpenVideo({ owner: video.owner, id: video.id, video }) } : { href: videoPath(publicPagePath(video.owner), video.id) })}
                />
              ))}
            </div>
            {list.videos.length > SHOWN && !open && (
              <button type="button" className="nu-home__link" data-nu-role="playlist-show-all" onClick={() => setAll(new Set(all).add(list.id))}>
                Show all {list.videos.length}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
