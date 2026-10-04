import { useEffect, useState } from 'react';
import { decryptAttachment, type EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { useMatrixClient } from '../MatrixClientContext';
import { needsMediaAuthentication } from '../mediaAuth';
import { fetchMedia } from '../mediaFetch';
import { mediaWorkerReady } from '../mediaWorker';

export type AttachmentSource = {
  /** Plain (unencrypted room) attachment: the raw `mxc://` URL. */
  url?: string;
  /** E2EE-encrypted attachment: per-file AES key/iv/hashes plus the `mxc://` URL to fetch. This
   *  is a *separate* layer from the room's own message encryption — the event content JSON is
   *  already decrypted by the time this sees it, but the attached file bytes need their own
   *  decrypt per the Matrix encrypted-attachments spec. */
  file?: EncryptedAttachmentInfo & { url: string };
  mimetype?: string;
};

export type AttachmentOptions = {
  /** For an `<img>`, `<video>` or `<audio>` only: hand back the media URL itself when the service
   *  worker can sign it (matrix/mediaWorker.ts), so video streams and images load lazily and are
   *  cached. Never for a download link: a link to another origin opens rather than saves, and
   *  the worker doesn't sign navigations. Encrypted files always come back as a blob. */
  direct?: boolean;
  /** A thumbnail of about this size instead of the whole file (unencrypted images only; see
   *  inlineThumbnailSize). Falls back to the whole file when the server has none. */
  thumbnail?: { width: number; height: number };
};

const attachmentUrlCache = new Map<string, Promise<string>>();

async function blobUrl(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string,
  httpUrl: string,
  useAuth: boolean,
  source: AttachmentSource
): Promise<string> {
  const res = await fetchMedia(mx, mxcUrl, httpUrl, useAuth);
  const bytes = await res.arrayBuffer();
  const decrypted = source.file ? await decryptAttachment(bytes, source.file) : new Uint8Array(bytes);
  const blob = new Blob([decrypted], { type: source.mimetype });
  return URL.createObjectURL(blob);
}

async function resolveAttachment(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string,
  source: AttachmentSource,
  options: AttachmentOptions
): Promise<string> {
  const useAuth = await needsMediaAuthentication(mx);
  const full = mx.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, undefined, undefined, useAuth);
  if (!full) throw new Error('Invalid media URL');
  if (source.file) return blobUrl(mx, mxcUrl, full, useAuth, source);

  const thumb = options.thumbnail
    ? mx.mxcUrlToHttp(mxcUrl, options.thumbnail.width, options.thumbnail.height, 'scale', undefined, undefined, useAuth)
    : null;
  if (options.direct && (!useAuth || (await mediaWorkerReady()))) return thumb ?? full;
  if (thumb) {
    try {
      return await blobUrl(mx, mxcUrl, thumb, useAuth, source);
    } catch {
      // No thumbnail for this file (or its server makes none): the whole file instead.
    }
  }
  return blobUrl(mx, mxcUrl, full, useAuth, source);
}

/** Image types whose thumbnail would lose something: animation, or vector sharpness. */
const KEEP_WHOLE = /^image\/(gif|webp|apng|png;\s*animated|svg\+xml)/;

/**
 * The thumbnail size for an image shown inline in a box of `boxWidth` × `boxHeight` CSS pixels,
 * or undefined when the whole file should load: a type a thumbnail would flatten (GIF, WebP,
 * which can be animated), or an image already about that small. Twice the box, for sharp
 * images on high-density screens.
 */
export function inlineThumbnailSize(
  mimetype: string | undefined,
  width: number | undefined,
  height: number | undefined,
  boxWidth: number,
  boxHeight: number
): { width: number; height: number } | undefined {
  if (!mimetype || KEEP_WHOLE.test(mimetype)) return undefined;
  const target = { width: boxWidth * 2, height: boxHeight * 2 };
  if (width && height && width <= target.width && height <= target.height) return undefined;
  return target;
}

/**
 * Resolves a message attachment's `url` (plain) or `file` (encrypted) into a usable src. By
 * default it fetches the bytes itself and hands back a blob URL — required for encrypted
 * attachments, and the only way to attach the access token where the homeserver wants one on
 * media. `options.direct` and `options.thumbnail` (above) make the common case, an unencrypted
 * image or video shown inline, much lighter. A fetch that fails for a reason that may pass
 * (another server slow to answer ours) is asked again a few times (matrix/mediaFetch.ts).
 */
export function useAttachmentUrl(source: AttachmentSource, options: AttachmentOptions = {}): string | null {
  const mx = useMatrixClient();
  const [src, setSrc] = useState<string | null>(null);
  const mxcUrl = source.file?.url ?? source.url;
  const direct = !!options.direct;
  const thumbWidth = options.thumbnail?.width;
  const thumbHeight = options.thumbnail?.height;

  useEffect(() => {
    if (!mxcUrl) {
      setSrc(null);
      return undefined;
    }

    let cancelled = false;
    const thumbnail = thumbWidth && thumbHeight ? { width: thumbWidth, height: thumbHeight } : undefined;
    const key = `${mxcUrl}|${direct ? 'direct' : 'blob'}|${thumbnail ? `${thumbnail.width}x${thumbnail.height}` : 'full'}`;
    let cached = attachmentUrlCache.get(key);
    if (!cached) {
      cached = resolveAttachment(mx, mxcUrl, source, { direct, thumbnail }).catch((err: unknown) => {
        attachmentUrlCache.delete(key); // don't poison the cache with a failed attempt
        throw err;
      });
      attachmentUrlCache.set(key, cached);
    }

    cached
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, mxcUrl, source.mimetype, direct, thumbWidth, thumbHeight]);

  return src;
}
