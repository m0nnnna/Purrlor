import type { MatrixClient } from 'matrix-js-sdk';
import { ensureProfileRoom, getOwnProfileRoomId } from './profileFeed';
import { emptyProfilePage, parseProfilePage, PROFILE_PAGE_DRAFT_ACCOUNT_DATA, PROFILE_PAGE_EVENT, toStoredPage, type ProfilePage } from './profilePage';

/**
 * Reading and writing profile pages (profilePage.ts has the format). The published page is state
 * in the owner's profile room; the draft is the owner's account data, so it follows them between
 * devices and nobody else sees it.
 */

/**
 * The published page in a profile room, or undefined. From synced state when this client is in
 * the room (it's current then); otherwise one read of the state event, which a homeserver answers
 * for anyone because the room is world-readable.
 */
export async function readProfilePage(mx: MatrixClient, roomId: string): Promise<ProfilePage | undefined> {
  const room = mx.getRoom(roomId);
  if (room?.getMyMembership() === 'join') {
    return parseProfilePage(room.currentState.getStateEvents(PROFILE_PAGE_EVENT, '')?.getContent());
  }
  try {
    return parseProfilePage(await mx.getStateEvent(roomId, PROFILE_PAGE_EVENT, ''));
  } catch {
    // No page (M_NOT_FOUND), or a room this server can't read: either way, no page to show.
    return undefined;
  }
}

/** The published page's own event ID, for reporting it. Undefined when there's no page. */
export async function readProfilePageEventId(mx: MatrixClient, roomId: string): Promise<string | undefined> {
  const room = mx.getRoom(roomId);
  if (room?.getMyMembership() === 'join') return room.currentState.getStateEvents(PROFILE_PAGE_EVENT, '')?.getId() ?? undefined;
  const state = (await mx.roomState(roomId).catch(() => [])) as { type?: string; state_key?: string; event_id?: string }[];
  return state.find((event) => event.type === PROFILE_PAGE_EVENT && event.state_key === '')?.event_id;
}

/** Publishes your page, creating your profile room first if you've never posted globally. */
export async function publishProfilePage(mx: MatrixClient, page: ProfilePage, displayName: string): Promise<void> {
  const roomId = await ensureProfileRoom(mx, displayName);
  // Through the parser on the way out too, so what's published is exactly what will be drawn.
  const clean = parseProfilePage(page);
  if (!clean) throw new Error('That page couldn’t be saved.');
  await mx.sendStateEvent(roomId, PROFILE_PAGE_EVENT as any, toStoredPage(clean) as any, '');
}

/** Takes your page down: your profile goes back to looking the way it did before. */
export async function unpublishProfilePage(mx: MatrixClient): Promise<void> {
  const roomId = getOwnProfileRoomId(mx);
  if (!roomId) return;
  await mx.sendStateEvent(roomId, PROFILE_PAGE_EVENT as any, {} as any, '');
}

type StoredDraft = { page?: unknown; updated_ts?: number };

export function readProfilePageDraft(mx: MatrixClient): ProfilePage | undefined {
  const content = mx.getAccountData(PROFILE_PAGE_DRAFT_ACCOUNT_DATA as any)?.getContent<StoredDraft>();
  return parseProfilePage(content?.page);
}

export async function saveProfilePageDraft(mx: MatrixClient, page: ProfilePage): Promise<void> {
  await mx.setAccountData(PROFILE_PAGE_DRAFT_ACCOUNT_DATA as any, { page, updated_ts: Date.now() } as any);
}

export async function discardProfilePageDraft(mx: MatrixClient): Promise<void> {
  await mx.setAccountData(PROFILE_PAGE_DRAFT_ACCOUNT_DATA as any, {} as any);
}

/** What a page's images may be: still or animated pictures a browser draws itself. */
export const PAGE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Uploads an image for your page and gives back its mxc:// URL. Plain (not encrypted), since the
 * page it goes on is public; the homeserver's own upload limit applies.
 */
export async function uploadPageImage(mx: MatrixClient, file: File): Promise<string> {
  if (!PAGE_IMAGE_TYPES.includes(file.type)) throw new Error('Pick a PNG, JPG, GIF or WebP image.');
  const { content_uri: mxcUrl } = await mx.uploadContent(file, { type: file.type, name: file.name });
  return mxcUrl;
}

/**
 * "Copy this page's style": someone else's colours, background, fonts and effect, put into your
 * own draft. Your blocks stay as they are; nothing is published until you publish.
 */
export async function copyStyleToDraft(mx: MatrixClient, style: ProfilePage['style']): Promise<void> {
  const ownRoomId = getOwnProfileRoomId(mx);
  const base = readProfilePageDraft(mx) ?? (ownRoomId ? await readProfilePage(mx, ownRoomId) : undefined) ?? emptyProfilePage();
  await saveProfilePageDraft(mx, { ...base, style: structuredClone(style) });
}
