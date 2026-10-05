import type { MatrixClient } from 'matrix-js-sdk';

export type ThumbnailMethod = 'crop' | 'scale';
export type ThumbnailSize = { width: number; height: number; method: ThumbnailMethod };

/**
 * The thumbnails a homeserver makes: Continuwuity's fixed sizes, which are also Synapse's defaults.
 * A request is answered with the first of these it fits in (both sides no larger), whatever exact
 * size or method it asked for, and one larger than all of them gets the whole original file
 * (checked against the e2e homeserver: 720×640 came back as the 1600×1200 original).
 *
 * So asking for 56×56, 80×80 and 96×96 got the same 96×96 thumbnail three times under three URLs,
 * each downloaded and cached apart; and an image in a message, asked for at 720×640, downloaded
 * the whole original every time. Asking for exactly these sizes means one URL per thumbnail, made
 * once by the homeserver and kept once on the device (public/sw.js).
 */
export const SERVER_THUMBNAILS: readonly ThumbnailSize[] = [
  { width: 32, height: 32, method: 'crop' },
  { width: 96, height: 96, method: 'crop' },
  { width: 320, height: 240, method: 'scale' },
  { width: 640, height: 480, method: 'scale' },
  { width: 800, height: 600, method: 'scale' },
];

const LARGEST = SERVER_THUMBNAILS[SERVER_THUMBNAILS.length - 1];

/**
 * The server's thumbnail a request for `width` × `height` gets, or undefined when it would get the
 * whole file. `capped`: the largest thumbnail rather than the whole file, for a picture shown in a
 * box (a thumbnail of 800×600 is plenty for one drawn at 360×320, even on a sharp screen).
 */
export function serverThumbnail(width: number, height: number, { capped = false } = {}): ThumbnailSize | undefined {
  const fit = SERVER_THUMBNAILS.find((size) => width <= size.width && height <= size.height);
  return fit ?? (capped ? LARGEST : undefined);
}

/** The media URL for a thumbnail of about this size: the server's own size, or the whole file. */
export function thumbnailHttpUrl(mx: MatrixClient, mxcUrl: string, width: number, height: number, useAuth: boolean): string | null {
  const size = serverThumbnail(width, height);
  return size
    ? mx.mxcUrlToHttp(mxcUrl, size.width, size.height, size.method, undefined, undefined, useAuth)
    : mx.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, undefined, undefined, useAuth);
}
