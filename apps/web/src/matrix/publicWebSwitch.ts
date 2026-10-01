import type { MatrixClient } from 'matrix-js-sdk';
import { ensureProfileRoom, getOwnProfileRoomId } from './profileFeed';

/**
 * The opt-in for showing your page to people who aren't signed in (docs/public-web.md). One state
 * event in your profile room, which only you can set; the public web's service reads it on every
 * feed refresh, so turning it off takes effect within a minute. Off unless it says `enabled: true`.
 * Your Global posts are public either way: this is only about your page.
 */
export const PUBLIC_WEB_EVENT = 'xyz.nekous.public_web';

export function parsePublicWebEnabled(content: unknown): boolean {
  return !!content && typeof content === 'object' && (content as { enabled?: unknown }).enabled === true;
}

/** Whether your page is shown to signed-out visitors, from your own synced profile room. */
export function readPublicWebEnabled(mx: MatrixClient): boolean {
  const roomId = getOwnProfileRoomId(mx);
  const room = roomId ? mx.getRoom(roomId) : null;
  return parsePublicWebEnabled(room?.currentState.getStateEvents(PUBLIC_WEB_EVENT, '')?.getContent());
}

/** Turns it on or off, creating your profile room first if you've never posted globally. */
export async function setPublicWebEnabled(mx: MatrixClient, enabled: boolean, displayName: string): Promise<void> {
  const roomId = enabled ? await ensureProfileRoom(mx, displayName) : getOwnProfileRoomId(mx);
  if (!roomId) return; // Off with no profile room: there's nothing shown to turn off.
  await mx.sendStateEvent(roomId, PUBLIC_WEB_EVENT as any, { enabled } as any, '');
}

/** Your public link, as people would type it: this server's address and your username. */
export function publicPageUrl(mx: MatrixClient): string | undefined {
  const userId = mx.getUserId();
  const name = userId?.match(/^@([^:]+):/)?.[1];
  return name ? `${window.location.origin}/@${name}` : undefined;
}
