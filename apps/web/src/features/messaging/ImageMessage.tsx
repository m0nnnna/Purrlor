import { useState, type CSSProperties } from 'react';
import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { INLINE_IMAGE_BOX, inlineThumbnailSize, useAttachmentUrl } from '../../matrix/hooks/useAttachmentUrl';
import { AttachmentLightbox } from './AttachmentLightbox';
import './ImageMessage.css';

type ImageMessageProps = {
  body: string;
  url?: string;
  file?: (EncryptedAttachmentInfo & { url: string }) | undefined;
  mimetype?: string;
  /** The original image's pixel dimensions, from the event's own `info.w`/`info.h`. */
  width?: number;
  height?: number;
};

const { width: MAX_WIDTH_PX, height: MAX_HEIGHT_PX } = INLINE_IMAGE_BOX;

export function ImageMessage({ body, url, file, mimetype, width, height }: ImageMessageProps) {
  // A thumbnail inline (a fraction of the bytes, and another server sends its own small copy
  // rather than the original crossing over first); the whole file in the lightbox. If the
  // thumbnail won't load, the whole file instead.
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const thumbnail = thumbnailFailed ? undefined : inlineThumbnailSize(mimetype, width, height, MAX_WIDTH_PX, MAX_HEIGHT_PX);
  const src = useAttachmentUrl({ url, file, mimetype }, { direct: true, thumbnail });
  const [open, setOpen] = useState(false);

  // Reserve the image's proportional space up front from its known dimensions, so the box is
  // already the right shape before the bytes (fetch + decrypt) finish — that's what actually
  // fixes images "pushing the scroll position off": there's nothing left to expand into once
  // the layout doesn't change when the real image lands.
  //
  // The width is pinned too, not just the ratio: the placeholder is a block <div> (fills the
  // available width) but the loaded image is a <button> (shrinks to fit its content), so with
  // only an aspect-ratio the two came out different sizes and the timeline still jumped.
  const style: CSSProperties | undefined =
    width && height
      ? { aspectRatio: `${width} / ${height}`, width: Math.min(width, MAX_WIDTH_PX, (MAX_HEIGHT_PX * width) / height) }
      : undefined;

  if (!src) {
    return (
      <div className="nu-image-message nu-image-message--loading" data-nu-role="timeline-image" style={style}>
        {!style && (body || 'image')}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="nu-image-message"
        data-nu-role="timeline-image"
        onClick={() => setOpen(true)}
        style={style}
      >
        <img
          className="nu-image-message__img"
          src={src}
          alt={body}
          onError={thumbnail ? () => setThumbnailFailed(true) : undefined}
        />
      </button>
      {open && (
        <AttachmentLightbox source={{ url, file, mimetype }} preview={src} alt={body} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
