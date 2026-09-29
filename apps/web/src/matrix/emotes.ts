import type { MatrixClient, Room } from 'matrix-js-sdk';

/**
 * Custom room emotes *and* stickers via MSC2545 "image packs" — the same real, spec-adjacent
 * mechanism Element/cinny/FluffyChat use, not a Purrlor-only thing. One pack per room (state_key
 * `""`), stored as `im.ponies.room_emotes`. Not in matrix-js-sdk's built-in EventType enum (it's
 * an MSC, not core spec) so it's passed as a raw string, same as cinny does.
 *
 * MSC2545 lets each image declare its own `usage` (`["emoticon"]`, `["sticker"]`, or both) —
 * that's the one field distinguishing an emote (inserted as `:shortcode:` text, rendered inline)
 * from a sticker (sent as its own `m.sticker` event, rendered as a standalone image). An image
 * with no `usage` at all is treated as emoticon-only here, matching every pack this app itself
 * ever wrote before stickers existed.
 */
export const EMOTE_EVENT_TYPE = 'im.ponies.room_emotes';

export type Emote = { shortcode: string; mxcUrl: string };
export type Sticker = { shortcode: string; mxcUrl: string; body: string };

export type PackUsage = 'emoticon' | 'sticker';
export type PackImage = { url: string; usage?: PackUsage[]; body?: string };
export type RoomEmotesContent = {
  pack?: { display_name?: string };
  images?: Record<string, PackImage>;
};

function readContent(room: Room): RoomEmotesContent {
  return room.currentState.getStateEvents(EMOTE_EVENT_TYPE, '')?.getContent<RoomEmotesContent>() ?? {};
}

export function isUsableAs(image: PackImage, usage: PackUsage): boolean {
  return !image.usage ? usage === 'emoticon' : image.usage.includes(usage);
}

export function getRoomEmotes(room: Room): Emote[] {
  const images = readContent(room).images ?? {};
  return Object.entries(images)
    .filter((entry): entry is [string, PackImage] => typeof entry[1]?.url === 'string' && isUsableAs(entry[1], 'emoticon'))
    .map(([shortcode, image]) => ({ shortcode, mxcUrl: image.url }));
}

export function getRoomStickers(room: Room): Sticker[] {
  const images = readContent(room).images ?? {};
  return Object.entries(images)
    .filter((entry): entry is [string, PackImage] => typeof entry[1]?.url === 'string' && isUsableAs(entry[1], 'sticker'))
    .map(([shortcode, image]) => ({ shortcode, mxcUrl: image.url, body: image.body || shortcode }));
}

/** Lists of images merged by shortcode, a later list winning a collision — so callers pass the
 *  widest scope first (global library, then Space, then channel) and the most specific wins. */
export function mergeByShortcode<T extends { shortcode: string }>(...lists: T[][]): T[] {
  const merged = new Map<string, T>();
  lists.forEach((list) => list.forEach((item) => merged.set(item.shortcode, item)));
  return [...merged.values()];
}

export type EmoteSource = 'global' | 'space' | 'channel';
export type SourcedEmote = Emote & { source: EmoteSource };

/**
 * Same collision rule as `mergeByShortcode` (most specific scope wins a shared shortcode), but
 * keeping each surviving emote's scope on it instead of flattening it away — for
 * EmojiAndEmotePicker's grouped "Global / This server / Channel" sections, where which group an
 * emote lands in *is* the point, not just whether it shows up at all.
 */
export function groupEmotesBySource(global: Emote[], space: Emote[], channel: Emote[]): SourcedEmote[] {
  const seen = new Set<string>();
  const scoped: [Emote[], EmoteSource][] = [
    [channel, 'channel'],
    [space, 'space'],
    [global, 'global'],
  ];
  const result: SourcedEmote[] = [];
  for (const [emotes, source] of scoped) {
    for (const emote of emotes) {
      if (seen.has(emote.shortcode)) continue;
      seen.add(emote.shortcode);
      result.push({ ...emote, source });
    }
  }
  return result;
}

export async function addRoomImage(
  mx: MatrixClient,
  room: Room,
  shortcode: string,
  mxcUrl: string,
  usage: PackUsage[]
): Promise<void> {
  const content = readContent(room);
  const images = { ...content.images, [shortcode]: { url: mxcUrl, usage, body: shortcode } };
  // im.ponies.room_emotes is an MSC, not in matrix-js-sdk's core EventType/StateEvents map, so
  // sendStateEvent's generic can't infer a content type for it — same escape hatch cinny uses.
  await mx.sendStateEvent(room.roomId, EMOTE_EVENT_TYPE as any, { ...content, images } as any, '');
}

export async function removeRoomImage(mx: MatrixClient, room: Room, shortcode: string): Promise<void> {
  const content = readContent(room);
  const images = { ...content.images };
  delete images[shortcode];
  await mx.sendStateEvent(room.roomId, EMOTE_EVENT_TYPE as any, { ...content, images } as any, '');
}
