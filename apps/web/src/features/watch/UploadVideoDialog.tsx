import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useOwnProfile } from '../../matrix/hooks/useOwnProfile';
import { formatBytes } from '../../matrix/postMedia';
import {
  formatLength,
  prepareVideo,
  publishVideo,
  thumbnailFromPicture,
  titleFromFileName,
  VIDEO_ACCEPT,
  VIDEO_LIMITS,
  type PreparedVideo,
  type VideoVisibility,
  type WatchVideo,
} from '../../matrix/videos';
import './Watch.css';

/** A preview address for a picture that isn't uploaded yet, freed when it changes or the dialog closes. */
function usePreviewUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return undefined;
    }
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

/**
 * Upload a video to your channel (docs/watch.md): pick an MP4 or WebM, see its length and the
 * frame taken about 10% in (or choose a picture), give it a title, then watch the upload's bar.
 */
export function UploadVideoDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: (video: WatchVideo) => void }) {
  const mx = useMatrixClient();
  const { displayName } = useOwnProfile();
  const [prepared, setPrepared] = useState<PreparedVideo>();
  const [thumbnail, setThumbnail] = useState<Blob>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<VideoVisibility>('public');
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<string>();
  const preview = usePreviewUrl(thumbnail);
  const uploading = progress !== undefined;
  const closed = useRef(false);
  useEffect(
    () => () => {
      closed.current = true;
    },
    []
  );

  const pickVideo = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    setChecking(true);
    try {
      const next = await prepareVideo(mx, file);
      setPrepared(next);
      setThumbnail(next.thumbnail);
      setTitle((current) => current || titleFromFileName(file.name));
    } catch (err) {
      setPrepared(undefined);
      setThumbnail(undefined);
      setError(err instanceof Error ? err.message : 'Couldn’t read that file.');
    } finally {
      setChecking(false);
    }
  };

  const pickPicture = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      setThumbnail(await thumbnailFromPicture(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t use that picture.');
    }
  };

  const submit = async () => {
    if (!prepared || !thumbnail || uploading) return;
    setError(undefined);
    setProgress(0);
    try {
      const video = await publishVideo(mx, prepared, thumbnail, { title, description, visibility }, displayName, setProgress);
      onUploaded(video);
      if (!closed.current) onClose();
    } catch (err) {
      setProgress(undefined);
      setError(err instanceof Error ? err.message : 'Couldn’t upload the video. Try again.');
    }
  };

  return (
    <Modal title="Upload a video" onClose={uploading ? () => undefined : onClose}>
      <form
        className="nu-watch-form"
        data-nu-role="video-upload"
        onSubmit={(evt) => {
          evt.preventDefault();
          void submit();
        }}
      >
        <label className="nu-field">
          Video (MP4 or WebM)
          <input
            className="nu-field__input"
            type="file"
            accept={VIDEO_ACCEPT}
            data-nu-role="video-upload-file"
            disabled={uploading || checking}
            onChange={(evt) => {
              void pickVideo(evt.target.files?.[0]);
              evt.target.value = '';
            }}
          />
        </label>
        {checking && <p className="nu-field__hint">Reading the video…</p>}
        {prepared && (
          <>
            <p className="nu-field__hint" data-nu-role="video-upload-info">
              {prepared.file.name} · {formatLength(prepared.duration)} · {prepared.w}×{prepared.h} · {formatBytes(prepared.file.size)}
            </p>
            <div className="nu-watch-form__thumb">
              {preview ? <img src={preview} alt="Thumbnail" data-nu-role="video-upload-thumb" /> : <span className="nu-field__hint">No picture could be taken from the video.</span>}
              <label className="nu-button nu-button--secondary">
                {preview ? 'Choose another picture' : 'Choose a picture'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  data-nu-role="video-upload-thumb-file"
                  disabled={uploading}
                  onChange={(evt) => {
                    void pickPicture(evt.target.files?.[0]);
                    evt.target.value = '';
                  }}
                />
              </label>
            </div>
            <label className="nu-field">
              Title
              <input className="nu-field__input" data-nu-role="video-upload-title" value={title} maxLength={VIDEO_LIMITS.title} disabled={uploading} onChange={(evt) => setTitle(evt.target.value)} />
            </label>
            <label className="nu-field">
              Description (optional)
              <textarea
                className="nu-field__textarea"
                data-nu-role="video-upload-description"
                value={description}
                maxLength={VIDEO_LIMITS.description}
                rows={4}
                disabled={uploading}
                onChange={(evt) => setDescription(evt.target.value)}
              />
            </label>
            <VisibilityField value={visibility} disabled={uploading} onChange={setVisibility} />
          </>
        )}
        {uploading && (
          <progress className="nu-watch-form__progress" data-nu-role="video-upload-progress" max={1} value={progress} aria-label="Upload progress" />
        )}
        {error && (
          <p className="nu-field__error" role="alert" data-nu-role="video-upload-error">
            {error}
          </p>
        )}
        <div className="nu-watch-form__actions">
          <button type="button" className="nu-button nu-button--secondary" disabled={uploading} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="video-upload-submit" disabled={!prepared || !thumbnail || !title.trim() || uploading}>
            {uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : 'Upload'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function VisibilityField({ value, disabled, onChange }: { value: VideoVisibility; disabled?: boolean; onChange: (value: VideoVisibility) => void }) {
  return (
    <label className="nu-field">
      Who can watch
      <select className="nu-field__input" data-nu-role="video-visibility" value={value} disabled={disabled} onChange={(evt) => onChange(evt.target.value as VideoVisibility)}>
        <option value="public">Anyone, including people who aren’t signed in</option>
        <option value="private">Only people who are signed in</option>
      </select>
    </label>
  );
}
