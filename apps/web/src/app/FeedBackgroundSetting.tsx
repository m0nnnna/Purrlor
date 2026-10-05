import { useEffect, useState } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import { DEFAULT_DIM, saveFeedBackground, useFeedBackground } from '../matrix/feedBackground';
import { useProfilePage } from '../matrix/hooks/useProfilePage';
import { getOwnProfileRoomId } from '../matrix/profileFeed';
import { ImagePicker, ImageThumb } from '../features/profilePage/ImagePicker';

/** Account Settings → Appearance: a picture of your own behind the main feed (matrix/feedBackground.ts). */
export function FeedBackgroundSetting() {
  const mx = useMatrixClient();
  const background = useFeedBackground();
  // Your profile page's picture, offered as a one-click choice when it has one.
  const { page } = useProfilePage(getOwnProfileRoomId(mx), mx.getUserId() ?? undefined);
  const pagePicture = page?.style.background.kind === 'image' ? page.style.background.url : undefined;
  const saved = background?.dim ?? DEFAULT_DIM;
  // The slider moves at once; it's saved a moment after it stops, not on every step of a drag.
  const [dim, setDim] = useState(saved);
  useEffect(() => setDim(saved), [saved]);
  useEffect(() => {
    if (!background || dim === saved) return undefined;
    const timer = setTimeout(() => void saveFeedBackground(mx, { url: background.url, dim }), 400);
    return () => clearTimeout(timer);
  }, [background, dim, saved, mx]);
  const save = (url: string | undefined) => void saveFeedBackground(mx, url ? { url, dim } : undefined);

  return (
    <div className="nu-field" data-nu-role="feed-background-setting">
      Feed background
      <div className="nu-feed-background-setting__row">
        {background && <ImageThumb mxc={background.url} onRemove={() => save(undefined)} />}
        <ImagePicker label={background ? 'Change picture…' : 'Upload a picture…'} onUploaded={([url]) => save(url)} />
        {pagePicture && pagePicture !== background?.url && (
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="feed-background-use-page" onClick={() => save(pagePicture)}>
            Use my page’s background
          </button>
        )}
      </div>
      {background && (
        <label className="nu-feed-background-setting__dim">
          Dim: {dim}%
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={dim}
            data-nu-role="feed-background-dim"
            onChange={(evt) => setDim(Number(evt.target.value))}
          />
        </label>
      )}
      <span className="nu-field__hint">
        A picture or GIF behind the Everyone and Following feeds. Only you see it, on every device you sign in on.
      </span>
    </div>
  );
}
