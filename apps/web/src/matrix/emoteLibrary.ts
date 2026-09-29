import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  EMOTE_EVENT_TYPE,
  isUsableAs,
  type Emote,
  type PackImage,
  type PackUsage,
  type RoomEmotesContent,
  type Sticker,
} from './emotes';
import { canRedactEvent, canSendStateEvent, defaultUserPowerLevel, userPowerLevel } from './permissions';

/**
 * The **global emote library**: emotes and stickers anyone on this homeserver can add, and anyone
 * can use in any channel, DM or post — alongside the per-channel and per-Space packs in emotes.ts,
 * as the widest scope (a Space's or channel's own `:cat:` still wins over a global one).
 *
 * It's one ordinary room, found by its alias `#purrlor-emotes:<server>` and joined in the
 * background by everyone (EmoteLibraryWatcher.tsx), holding standard MSC2545 packs — **one pack
 * per person**, state key = their user ID. Matrix's auth rules reject a state event whose key
 * starts with `@` unless it's the sender's own ID, so nobody can edit anyone else's pack, and the
 * room's power levels let everyone (level 0) send packs while nothing else in it (messages, name,
 * …) is open to them. A pack under any other key is ignored: at level 0 anyone could write one.
 *
 * Moderation, by the room's moderators (level 50):
 * - **Hide** one image — its mxc URL goes on a list in `xyz.nekous.emote_moderation`, and every
 *   Purrlor client leaves it out. The owner can't take it off that list.
 * - **Remove** someone's whole pack — a redaction of their pack event, which strips its content.
 * - **Mute** someone — power level -1, below what a pack needs, so they can't add anything more.
 *
 * The room is created by the server's admin, not by whoever gets there first (a first-come
 * creator would own everyone's moderation): `purrlor emotes setup` (deploy/purrlor, which the
 * installer runs too) makes it, and docs/api.md describes it for doing the same by hand.
 */
export const EMOTE_LIBRARY_ROOM_TYPE = 'xyz.nekous.emote_library';
export const EMOTE_LIBRARY_ALIAS_LOCALPART = 'purrlor-emotes';
export const EMOTE_MODERATION_EVENT = 'xyz.nekous.emote_moderation';

/** Extra key on a pack image (other clients ignore it): when it was added, so the first person
 *  to use a shortcode keeps it when two people pick the same one. */
const ADDED_AT_KEY = 'xyz.nekous.added_at';

/** Per-person limits, so one account can't fill the library (or its 64 KiB state event). */
export const LIBRARY_MAX_IMAGES_PER_PERSON = 50;
export const LIBRARY_MAX_FILE_BYTES = 1024 * 1024;

/** Below the level a pack needs (0), so a muted person's pack stays as it is but can't grow. */
export const MUTED_POWER_LEVEL = -1;

export function emoteLibraryAlias(serverName: string): string {
  return `#${EMOTE_LIBRARY_ALIAS_LOCALPART}:${serverName}`;
}

/**
 * Whether a room is this server's library: its type, and the alias the server vouches for (a
 * homeserver only accepts a canonical alias that really points at the room). Checked on the
 * room itself, so an invite to a look-alike room can't stand in for the real one.
 */
export function isEmoteLibraryRoom(room: Room, serverName: string): boolean {
  return room.getType() === EMOTE_LIBRARY_ROOM_TYPE && room.getCanonicalAlias() === emoteLibraryAlias(serverName);
}

/** For lists of rooms: the library, or anything claiming to be one, is never a chat. */
export function looksLikeEmoteLibrary(room: Room): boolean {
  return room.getType() === EMOTE_LIBRARY_ROOM_TYPE;
}

export function findEmoteLibrary(mx: MatrixClient): Room | undefined {
  const serverName = mx.getDomain();
  if (!serverName) return undefined;
  return mx.getRooms().find((room) => room.getMyMembership() === 'join' && isEmoteLibraryRoom(room, serverName));
}

/** Joins the library by its alias. Resolves to false when this server hasn't set one up. */
export async function joinEmoteLibrary(mx: MatrixClient): Promise<boolean> {
  const serverName = mx.getDomain();
  if (!serverName) return false;
  try {
    await mx.joinRoom(emoteLibraryAlias(serverName));
    return true;
  } catch {
    return false;
  }
}

export type LibraryImage = {
  owner: string;
  shortcode: string;
  mxcUrl: string;
  body: string;
  usage: PackUsage[];
  addedAt: number;
  hidden: boolean;
};

export type LibraryPack = { owner: string; event: MatrixEvent; images: LibraryImage[] };

type ModerationContent = { hidden?: unknown };

/** Every mxc URL a moderator has hidden (emoteLibrary.ts's class comment above) — exported so a
 *  message's own embedded emotes (parsed straight out of its formatted_body, see
 *  messageFormatting.ts's parseFormattedBodyEmotes) can be filtered against it too, not only the
 *  emotes/stickers this module already leaves them out of. */
export function readHidden(room: Room): Set<string> {
  const hidden = room.currentState.getStateEvents(EMOTE_MODERATION_EVENT, '')?.getContent<ModerationContent>().hidden;
  return new Set(Array.isArray(hidden) ? hidden.filter((url): url is string => typeof url === 'string') : []);
}

function isPersonalPack(event: MatrixEvent): boolean {
  const key = event.getStateKey();
  return !!key && key.startsWith('@') && key === event.getSender();
}

/** Everyone's packs, hidden images included (flagged) — what moderation shows. */
export function readLibraryPacks(room: Room): LibraryPack[] {
  const hidden = readHidden(room);
  const events = room.currentState.getStateEvents(EMOTE_EVENT_TYPE) as MatrixEvent[];
  return events.filter(isPersonalPack).flatMap((event) => {
    const owner = event.getStateKey() as string;
    const entries = Object.entries(event.getContent<RoomEmotesContent>().images ?? {});
    const images = entries
      .filter((entry): entry is [string, PackImage] => typeof entry[1]?.url === 'string' && entry[1].url.startsWith('mxc://'))
      .map(([shortcode, image]): LibraryImage => {
        const addedAt = (image as Record<string, unknown>)[ADDED_AT_KEY];
        return {
          owner,
          shortcode,
          mxcUrl: image.url,
          body: image.body || shortcode,
          usage: (['emoticon', 'sticker'] as const).filter((usage) => isUsableAs(image, usage)),
          addedAt: typeof addedAt === 'number' ? addedAt : event.getTs(),
          hidden: hidden.has(image.url),
        };
      });
    return images.length > 0 ? [{ owner, event, images }] : [];
  });
}

/**
 * The images everyone sees: not hidden, and one per shortcode — the earliest added, so a later
 * pack can't take over a shortcode people already use (ties go to the lower user ID, so every
 * client picks the same one).
 */
export function visibleLibraryImages(room: Room): LibraryImage[] {
  const winners = new Map<string, LibraryImage>();
  for (const image of readLibraryPacks(room).flatMap((pack) => pack.images)) {
    if (image.hidden) continue;
    const current = winners.get(image.shortcode);
    if (!current || image.addedAt < current.addedAt || (image.addedAt === current.addedAt && image.owner < current.owner)) {
      winners.set(image.shortcode, image);
    }
  }
  return [...winners.values()];
}

export function getLibraryEmotes(room: Room): Emote[] {
  return visibleLibraryImages(room)
    .filter((image) => image.usage.includes('emoticon'))
    .map(({ shortcode, mxcUrl }) => ({ shortcode, mxcUrl }));
}

export function getLibraryStickers(room: Room): Sticker[] {
  return visibleLibraryImages(room)
    .filter((image) => image.usage.includes('sticker'))
    .map(({ shortcode, mxcUrl, body }) => ({ shortcode, mxcUrl, body }));
}

function ownPack(room: Room, userId: string): RoomEmotesContent {
  return room.currentState.getStateEvents(EMOTE_EVENT_TYPE, userId)?.getContent<RoomEmotesContent>() ?? {};
}

export function countOwnLibraryImages(room: Room, userId: string): number {
  return Object.keys(ownPack(room, userId).images ?? {}).length;
}

export async function addLibraryImage(
  mx: MatrixClient,
  room: Room,
  shortcode: string,
  mxcUrl: string,
  usage: PackUsage[]
): Promise<void> {
  const userId = mx.getUserId() ?? '';
  const content = ownPack(room, userId);
  if (Object.keys(content.images ?? {}).length >= LIBRARY_MAX_IMAGES_PER_PERSON) {
    throw new Error(`You can have up to ${LIBRARY_MAX_IMAGES_PER_PERSON} images in the global library — remove one first.`);
  }
  if (visibleLibraryImages(room).some((image) => image.shortcode === shortcode)) {
    throw new Error(`:${shortcode}: is already in the global library — pick another shortcode.`);
  }
  const image = { url: mxcUrl, usage, body: shortcode, [ADDED_AT_KEY]: Date.now() };
  const next: RoomEmotesContent = {
    ...content,
    pack: content.pack ?? { display_name: `${mx.getUser(userId)?.displayName ?? userId}'s emotes` },
    images: { ...content.images, [shortcode]: image },
  };
  await mx.sendStateEvent(room.roomId, EMOTE_EVENT_TYPE as any, next as any, userId);
}

export async function removeLibraryImage(mx: MatrixClient, room: Room, shortcode: string): Promise<void> {
  const userId = mx.getUserId() ?? '';
  const content = ownPack(room, userId);
  const images = { ...content.images };
  delete images[shortcode];
  await mx.sendStateEvent(room.roomId, EMOTE_EVENT_TYPE as any, { ...content, images } as any, userId);
}

// --- Permissions ---------------------------------------------------------------------------

export function canContributeToLibrary(room: Room, userId: string): boolean {
  return canSendStateEvent(room, userId, EMOTE_EVENT_TYPE);
}

export function canModerateLibrary(room: Room, userId: string): boolean {
  return canSendStateEvent(room, userId, EMOTE_MODERATION_EVENT);
}

export function isMutedInLibrary(room: Room, userId: string): boolean {
  return !canContributeToLibrary(room, userId);
}

/** Muting changes someone's power level, so it takes the power to do that and outranking them. */
export function canMuteInLibrary(room: Room, moderatorId: string, targetId: string): boolean {
  return (
    moderatorId !== targetId &&
    canSendStateEvent(room, moderatorId, EventType.RoomPowerLevels) &&
    userPowerLevel(room, moderatorId) > userPowerLevel(room, targetId)
  );
}

export function canRemoveLibraryPack(room: Room, moderatorId: string, pack: LibraryPack): boolean {
  return canRedactEvent(room, moderatorId, pack.event);
}

// --- Moderation ----------------------------------------------------------------------------

export async function setLibraryImageHidden(mx: MatrixClient, room: Room, mxcUrl: string, hidden: boolean): Promise<void> {
  const current = room.currentState.getStateEvents(EMOTE_MODERATION_EVENT, '')?.getContent<Record<string, unknown>>() ?? {};
  const list = readHidden(room);
  if (hidden) list.add(mxcUrl);
  else list.delete(mxcUrl);
  await mx.sendStateEvent(room.roomId, EMOTE_MODERATION_EVENT as any, { ...current, hidden: [...list] } as any, '');
}

/** Takes down someone's whole pack. They can start a new one unless they're muted too. */
export async function removeLibraryPack(mx: MatrixClient, room: Room, pack: LibraryPack): Promise<void> {
  const eventId = pack.event.getId();
  if (!eventId) throw new Error("That pack hasn't finished saving yet.");
  await mx.redactEvent(room.roomId, eventId, undefined, { reason: 'Removed from the emote library by a moderator' });
}

export async function setLibraryMuted(mx: MatrixClient, room: Room, userId: string, muted: boolean): Promise<void> {
  await mx.setPowerLevel(room.roomId, userId, muted ? MUTED_POWER_LEVEL : defaultUserPowerLevel(room));
}
