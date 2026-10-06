import { encryptAttachment, type EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import type { MatrixClient } from 'matrix-js-sdk';
import { readTags, type ImageTag } from './imageTags';

/**
 * Media attached to a post — images (including animated GIF/WebP) and video (WebM/MP4).
 *
 * **Smaller uploads.** JPEG and PNG are re-encoded to WebP in the browser before upload: photos
 * and screenshots routinely come out a third to a half the size, which is bandwidth for every
 * reader and storage on the homeserver. The original is kept whenever re-encoding wouldn't
 * actually help (the WebP comes out bigger, or the browser can't encode WebP), and formats that
 * are already compact or animated — GIF, WebP, WebM, MP4 — go up untouched: a canvas can only
 * encode one still frame, so "converting" an animation would silently freeze it.
 *
 * **Who can open it.** Matrix media isn't access-controlled per room: an `mxc://` upload can be
 * fetched by anyone who has its URL (with any account on a server that requires authenticated
 * media, with none at all on one that doesn't). So where a post goes decides how its media is
 * stored:
 *
 * - **Public places** (Global, a public Space): a plain upload. The post is readable by anyone,
 *   so its media is too — and a plain upload is what lets a reader's browser cache it.
 * - **Anywhere else** (a private Space, an "Only me" post): the bytes are **encrypted in the
 *   browser before upload**, exactly like an attachment in an encrypted chat (the same library
 *   and format the timeline already decrypts). The key travels inside the post, and the post is
 *   only readable by the Space's members (feed.ts) or only by you (account data). What sits on
 *   the media server is ciphertext: fetching it by URL gets nobody anything.
 */

export type PostMediaKind = 'image' | 'video';

export type EncryptedFile = EncryptedAttachmentInfo & { url: string };

/** Exactly one of `url` (plain) or `file` (encrypted, key included) is set. */
export type PostAttachment = {
  kind: PostMediaKind;
  url?: string;
  file?: EncryptedFile;
  name: string;
  info: { mimetype: string; size: number; w?: number; h?: number };
  /** People tagged in a picture, and where (imageTags.ts). Pictures only. */
  tags?: ImageTag[];
};

/** The mxc URL the bytes live at, whichever way they're stored. */
export function attachmentMxc(attachment: PostAttachment): string {
  return attachment.file?.url ?? attachment.url ?? '';
}

export const MAX_ATTACHMENTS = 4;

/** About the widest a post's image is drawn, for its thumbnail (PostMedia.tsx; mediaWarm.ts asks
 *  for the same one ahead of time). */
export const POST_MEDIA_PX = 600;

/** Everything a post will accept, keyed to how it renders. */
const ACCEPTED: Record<string, PostMediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/webm': 'video',
  'video/mp4': 'video',
};

/** For the file picker's `accept` attribute. */
export const ACCEPTED_MEDIA_TYPES = Object.keys(ACCEPTED).join(',');

/** Longest edge a re-encoded still is scaled down to — past this, pixels are mostly weight. */
export const MAX_IMAGE_EDGE = 2560;
const WEBP_QUALITY = 0.85;

export function mediaKindOf(mimetype: string): PostMediaKind | undefined {
  return ACCEPTED[mimetype];
}

/** Only still JPEG/PNG are worth re-encoding (see the module comment for why nothing else is). */
export function shouldConvertToWebp(mimetype: string): boolean {
  return mimetype === 'image/jpeg' || mimetype === 'image/png';
}

/** Scales (w, h) down so neither edge exceeds `maxEdge`, keeping the aspect ratio. */
export function fitWithin(w: number, h: number, maxEdge = MAX_IMAGE_EDGE): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { w, h };
  const scale = maxEdge / longest;
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** `photo.jpg` → `photo.webp`, for the re-encoded upload's filename. */
export function webpName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`;
}

export type PreparedMedia = {
  file: Blob;
  name: string;
  kind: PostMediaKind;
  mimetype: string;
  w?: number;
  h?: number;
  /** Set when the file was re-encoded — the original's size, for the "saved N KB" hint. */
  originalSize?: number;
};

async function encodeWebp(bitmap: ImageBitmap, w: number, h: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
  // A browser without a WebP encoder silently hands back PNG instead of failing.
  return blob && blob.type === 'image/webp' ? blob : null;
}

function readVideoDimensions(file: Blob): Promise<{ w: number; h: number } | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (dims?: { w: number; h: number }) => {
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : undefined);
    video.onerror = () => done(undefined);
    video.src = url;
  });
}

/**
 * Validates a picked file and gets it ready to upload: WebP re-encode for stills, dimensions for
 * everything (so the post can reserve the right space before the media loads). Throws with a
 * message fit to show the user for anything a post can't carry.
 */
export async function prepareMedia(file: File): Promise<PreparedMedia> {
  const kind = mediaKindOf(file.type);
  if (!kind) throw new Error(`${file.name}: posts take JPG, PNG, GIF, WebP, WebM, or MP4.`);

  if (kind === 'video') {
    const dims = await readVideoDimensions(file);
    return { file, name: file.name, kind, mimetype: file.type, ...dims };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} couldn’t be read as an image.`);
  }
  try {
    if (shouldConvertToWebp(file.type)) {
      const target = fitWithin(bitmap.width, bitmap.height);
      const webp = await encodeWebp(bitmap, target.w, target.h);
      if (webp && webp.size < file.size) {
        return { file: webp, name: webpName(file.name), kind, mimetype: 'image/webp', ...target, originalSize: file.size };
      }
    }
    return { file, name: file.name, kind, mimetype: file.type, w: bitmap.width, h: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** The homeserver's upload limit, if it states one. */
export async function getUploadLimit(mx: MatrixClient): Promise<number | undefined> {
  try {
    const config = await mx.getMediaConfig();
    return config['m.upload.size'];
  } catch {
    return undefined;
  }
}

/**
 * Uploads one prepared file. `encrypt` for anything not headed to a public place (see the module
 * comment): the ciphertext goes up as an anonymous `application/octet-stream` with no filename —
 * the name and type are only safe inside the post, which only its audience can read.
 */
export async function uploadPostMedia(
  mx: MatrixClient,
  media: PreparedMedia,
  { encrypt, tags = [] }: { encrypt: boolean; tags?: ImageTag[] }
): Promise<PostAttachment> {
  const tagged = media.kind === 'image' && tags.length ? { tags } : {};
  const info = {
    mimetype: media.mimetype,
    size: media.file.size,
    ...(media.w && media.h && { w: media.w, h: media.h }),
  };
  if (encrypt) {
    const { data, info: keyInfo } = await encryptAttachment(await media.file.arrayBuffer());
    const { content_uri: url } = await mx.uploadContent(new Blob([data]), {
      type: 'application/octet-stream',
      includeFilename: false,
    });
    return { kind: media.kind, file: { ...keyInfo, url }, name: media.name, info, ...tagged };
  }
  const { content_uri: url } = await mx.uploadContent(media.file, { name: media.name, type: media.mimetype });
  return { kind: media.kind, url, name: media.name, info, ...tagged };
}

function isMxc(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('mxc://');
}

/** An encrypted-file block carries everything needed to decrypt: its key, IV, and hash. */
function isEncryptedFile(value: unknown): value is EncryptedFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  const key = file.key as Record<string, unknown> | undefined;
  const hashes = file.hashes as Record<string, unknown> | undefined;
  return isMxc(file.url) && typeof file.iv === 'string' && !!key && typeof key.k === 'string' && typeof hashes?.sha256 === 'string';
}

/** Attachments as read back off an event — anything malformed is dropped rather than rendered. */
export function readAttachments(raw: unknown): PostAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is PostAttachment =>
        !!item &&
        typeof item === 'object' &&
        (item.file !== undefined ? isEncryptedFile(item.file) && item.url === undefined : isMxc(item.url)) &&
        (item.kind === 'image' || item.kind === 'video') &&
        !!item.info &&
        typeof item.info.mimetype === 'string' &&
        mediaKindOf(item.info.mimetype) === item.kind
    )
    .slice(0, MAX_ATTACHMENTS)
    // Tags checked like everything else, and only on pictures.
    .map(({ tags, ...attachment }) => {
      const checked = attachment.kind === 'image' ? readTags(tags) : [];
      return checked.length ? { ...attachment, tags: checked } : attachment;
    });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
