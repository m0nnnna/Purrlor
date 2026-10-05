import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { needsMediaAuthentication } from './mediaAuth';
import { mediaWorkerReady } from './mediaWorker';
import { INLINE_IMAGE_BOX, inlineThumbnailSize } from './hooks/useAttachmentUrl';
import { thumbnailHttpUrl } from './thumbnails';

/**
 * Puts a room's recent images and its senders' avatars in the device's media cache (public/sw.js)
 * before the room is opened, so it opens with them already there. This matters most for another
 * server's media, which our homeserver fetches over federation the first time anyone asks for it:
 * that wait now happens in the background instead of while you look at grey boxes.
 *
 * Only what the timeline would ask for itself, at the same URL (so the cached copy is the one it
 * uses): an unencrypted image's inline thumbnail (or the whole image where the timeline shows the
 * whole one) and a 40px avatar. Encrypted files are left alone: they'd be fetched whole. Only with
 * the service worker signing and caching media; without it this would fetch for nothing.
 */

/** Images per room, the newest. */
const IMAGES_PER_ROOM = 12;
/** Avatars per room, of the newest senders. */
const AVATARS_PER_ROOM = 12;
/** The timeline's avatar (MessageTimeline.tsx: size 40), as Avatar.tsx asks for it. */
const AVATAR_PX = 80;
/** Requests at once, across every room, so warming never crowds out what's on screen. */
const CONCURRENCY = 3;

const warmed = new Set<string>();
const queue: string[] = [];
let running = 0;

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const url = queue.shift()!;
    running++;
    // `priority` is a hint browsers without it ignore.
    void fetch(url, { priority: 'low' } as RequestInit)
      // Read to the end, so the worker's copy (which shares this response) is complete.
      .then((res) => res.blob())
      .catch(() => {
        // Not there (yet): the timeline asks again when it's opened.
        warmed.delete(url);
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

function enqueue(url: string | null): void {
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  queue.push(url);
}

/** Queues a room's recent images and avatars for the device cache. Returns at once. */
export async function warmRoomMedia(mx: MatrixClient, room: Room): Promise<void> {
  if (!(await mediaWorkerReady())) return;
  const useAuth = await needsMediaAuthentication(mx);
  const events = room.getLiveTimeline().getEvents();
  let images = 0;
  const senders = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const content = event.getContent();
    const isImage = event.getType() === EventType.Sticker || (event.getType() === EventType.RoomMessage && content.msgtype === 'm.image');
    if (isImage && images < IMAGES_PER_ROOM && typeof content.url === 'string' && !event.isRedacted()) {
      images++;
      const info = content.info as { mimetype?: string; w?: number; h?: number } | undefined;
      const thumb = inlineThumbnailSize(info?.mimetype, info?.w, info?.h, INLINE_IMAGE_BOX.width, INLINE_IMAGE_BOX.height);
      enqueue(
        thumb
          ? mx.mxcUrlToHttp(content.url, thumb.width, thumb.height, thumb.method, undefined, undefined, useAuth)
          : mx.mxcUrlToHttp(content.url, undefined, undefined, undefined, undefined, undefined, useAuth)
      );
    }
    const avatar = event.sender?.getMxcAvatarUrl();
    if (avatar && senders.size < AVATARS_PER_ROOM && !senders.has(avatar)) {
      senders.add(avatar);
      enqueue(thumbnailHttpUrl(mx, avatar, AVATAR_PX, AVATAR_PX, useAuth));
    }
  }
  pump();
}
