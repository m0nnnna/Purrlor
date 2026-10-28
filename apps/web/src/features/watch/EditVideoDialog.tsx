import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { deleteVideo, editVideo, thumbnailFromPicture, VIDEO_LIMITS, type VideoVisibility, type WatchVideo } from '../../matrix/videos';
import { VisibilityField } from './UploadVideoDialog';
import './Watch.css';

/** Edit a video you own: title, description, thumbnail and who can watch; or delete it. */
export function EditVideoDialog({
  video,
  onClose,
  onSaved,
  onDeleted,
}: {
  video: WatchVideo;
  onClose: () => void;
  onSaved: (video: WatchVideo) => void;
  onDeleted: (video: WatchVideo) => void;
}) {
  const mx = useMatrixClient();
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description);
  const [visibility, setVisibility] = useState<VideoVisibility>(video.visibility);
  const [thumbnail, setThumbnail] = useState<Blob>();
  const [preview, setPreview] = useState<string>();
  const current = useMediaUrl(video.thumbnail.startsWith('mxc://') ? video.thumbnail : null, { width: 320, height: 180 });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!thumbnail) {
      setPreview(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(thumbnail);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [thumbnail]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await editVideo(mx, video, { title, description, visibility, ...(thumbnail && { thumbnail }) }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the changes. Try again.');
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await deleteVideo(mx, video);
      onDeleted(video);
      onClose();
    } catch {
      setError('Couldn’t delete the video. Try again.');
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <Modal title="Edit video" onClose={onClose}>
      <form
        className="nu-watch-form"
        data-nu-role="video-edit"
        onSubmit={(evt) => {
          evt.preventDefault();
          void save();
        }}
      >
        <div className="nu-watch-form__thumb">
          {(preview ?? current) && <img src={preview ?? current ?? undefined} alt="Thumbnail" />}
          <label className="nu-button nu-button--secondary">
            Change thumbnail
            <input
              type="file"
              accept="image/*"
              hidden
              data-nu-role="video-edit-thumb-file"
              disabled={busy}
              onChange={(evt) => {
                const file = evt.target.files?.[0];
                evt.target.value = '';
                if (file) thumbnailFromPicture(file).then(setThumbnail, (err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t use that picture.'));
              }}
            />
          </label>
        </div>
        <label className="nu-field">
          Title
          <input className="nu-field__input" data-nu-role="video-edit-title" value={title} maxLength={VIDEO_LIMITS.title} disabled={busy} onChange={(evt) => setTitle(evt.target.value)} />
        </label>
        <label className="nu-field">
          Description
          <textarea className="nu-field__textarea" data-nu-role="video-edit-description" value={description} maxLength={VIDEO_LIMITS.description} rows={4} disabled={busy} onChange={(evt) => setDescription(evt.target.value)} />
        </label>
        <VisibilityField value={visibility} disabled={busy} onChange={setVisibility} />
        {error && (
          <p className="nu-field__error" role="alert" data-nu-role="video-edit-error">
            {error}
          </p>
        )}
        <div className="nu-watch-form__actions">
          {confirming ? (
            <span className="nu-watch-form__confirm" data-nu-role="video-delete-confirm">
              Delete for good?
              <button type="button" className="nu-button nu-button--danger" data-nu-role="video-delete-yes" disabled={busy} onClick={() => void remove()}>
                Yes, delete
              </button>
              <button type="button" className="nu-button nu-button--secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <>
              <button type="button" className="nu-button nu-button--danger" data-nu-role="video-delete" disabled={busy} onClick={() => setConfirming(true)}>
                Delete
              </button>
              <button type="button" className="nu-button nu-button--secondary" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="nu-button nu-button--primary" data-nu-role="video-edit-save" disabled={busy || !title.trim()}>
                Save
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
