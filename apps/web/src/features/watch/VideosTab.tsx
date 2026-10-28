import { useState } from 'react';
import { useSetAtom } from 'jotai';
import type { WatchVideo } from '../../matrix/videos';
import { EditVideoDialog } from './EditVideoDialog';
import { UploadVideoDialog } from './UploadVideoDialog';
import { VideoCard } from './VideoCard';
import { openVideoAtom } from './watchState';
import { useCatalogue } from './useCatalogue';
import { useEndOfList } from './useInfiniteScroll';
import './Watch.css';

/**
 * The profile's Videos tab (docs/watch.md): a person's videos, newest first, from the catalogue.
 * On your own channel, Upload, and edit and delete on each card; what you change shows at once,
 * since the catalogue is rebuilt only every minute.
 */
export function VideosTab({ userId, name, isMe }: { userId: string; name: string; isMe: boolean }) {
  const setOpenVideo = useSetAtom(openVideoAtom);
  const catalogue = useCatalogue({ owners: [userId] });
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<WatchVideo>();
  const end = useEndOfList(catalogue.hasMore && !catalogue.loadingMore, catalogue.loadMore, catalogue.videos.length);

  return (
    <div className="nu-watch-tab" data-nu-role="profile-videos">
      {isMe && (
        <div className="nu-watch-tab__bar">
          <button type="button" className="nu-button nu-button--primary" data-nu-role="video-upload-open" onClick={() => setUploading(true)}>
            Upload a video
          </button>
        </div>
      )}
      <div className="nu-watch-grid">
        {catalogue.videos.map((video) => (
          <VideoCard
            key={video.id}
            video={video}
            showChannel={false}
            onOpen={() => setOpenVideo({ owner: video.owner, id: video.id, video })}
            actions={
              isMe && (
                <span className="nu-watch-card__actions">
                  <button type="button" className="nu-button nu-button--secondary" data-nu-role="video-edit-open" onClick={() => setEditing(video)}>
                    Edit
                  </button>
                </span>
              )
            }
          />
        ))}
      </div>
      {catalogue.loading && <p className="nu-feed__status">Loading videos…</p>}
      {catalogue.error && !catalogue.loading && (
        <p className="nu-feed__status" data-nu-role="videos-error">
          Couldn’t load videos right now.{' '}
          <button type="button" className="nu-home__link" onClick={catalogue.reload}>
            Try again
          </button>
        </p>
      )}
      {!catalogue.loading && !catalogue.error && catalogue.videos.length === 0 && (
        <p className="nu-feed__status" data-nu-role="videos-empty">
          {isMe ? 'Videos you upload show up here.' : `${name} hasn’t uploaded any videos you can watch.`}
        </p>
      )}
      <div ref={end} aria-hidden="true" />
      {uploading && <UploadVideoDialog onClose={() => setUploading(false)} onUploaded={(video) => catalogue.pin(video)} />}
      {editing && <EditVideoDialog video={editing} onClose={() => setEditing(undefined)} onSaved={catalogue.pin} onDeleted={catalogue.drop} />}
    </div>
  );
}
