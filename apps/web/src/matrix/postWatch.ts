import type { MatrixClient } from 'matrix-js-sdk';
import { formatBytes, type PostAttachment } from './postMedia';
import { frameToJpeg, postVideoDetails, publishUploadedVideo, videoSizeLimit, videoTypeOf, type Probe, type VideoType, type WatchVideo } from './videos';

/**
 * "Also add to WATCH" (docs/watch.md, "The app"): a post's MP4/WebM attachments, sent to a public
 * place as plain uploads, also become WATCH videos that reuse the post's `mxc` URL.
 */

/** A staged file's WATCH type: MP4 or WebM, or undefined (images, GIFs and the rest can't go). */
export function watchTypeOf(media: { kind: string; mimetype: string; name: string }): VideoType | undefined {
  return media.kind === 'video' ? videoTypeOf({ type: media.mimetype, name: media.name }) : undefined;
}

export type PostVideo = {
  /** The attachment as uploaded, plain. */
  attachment: PostAttachment;
  /** What the composer measured when the video was attached; undefined if the browser couldn't read it. */
  probe: Promise<Probe | undefined>;
};

/**
 * Publishes each video to the poster's profile room. One that fails or is skipped (over the size
 * limit, unreadable) doesn't stop the rest; `notes` says what happened, for the composer to show.
 */
export async function publishPostVideos(
  mx: MatrixClient,
  videos: PostVideo[],
  postText: string,
  displayName: string
): Promise<{ published: WatchVideo[]; notes: string[] }> {
  const published: WatchVideo[] = [];
  const notes: string[] = [];
  const limit = await videoSizeLimit(mx).catch(() => undefined);
  for (const { attachment, probe } of videos) {
    const mimetype = watchTypeOf({ kind: attachment.kind, mimetype: attachment.info.mimetype, name: attachment.name });
    const url = attachment.url;
    if (!mimetype || !url) continue;
    if (limit !== undefined && attachment.info.size > limit) {
      notes.push(`${attachment.name} is ${formatBytes(attachment.info.size)}, over the ${formatBytes(limit)} WATCH takes, so it wasn’t added there.`);
      continue;
    }
    try {
      const measured = await probe;
      if (!measured) throw new Error('this browser can’t read it');
      const { duration, w, h } = measured;
      const thumbnail = measured.thumbnail ?? (await blankThumbnail(w, h));
      published.push(
        await publishUploadedVideo(mx, { url, mimetype, size: attachment.info.size, duration, w, h }, thumbnail, postVideoDetails(postText, attachment.name), displayName)
      );
    } catch (err) {
      notes.push(`Couldn’t add ${attachment.name} to WATCH: ${err instanceof Error ? err.message : 'something went wrong'}.`);
    }
  }
  return { published, notes };
}

/** A plain dark picture for a video the browser couldn't draw a frame of. */
async function blankThumbnail(w: number, h: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = Math.max(1, Math.round((16 * h) / w));
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#111';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const blob = await frameToJpeg(canvas, canvas.width, canvas.height);
  if (!blob) throw new Error('no thumbnail could be made');
  return blob;
}
