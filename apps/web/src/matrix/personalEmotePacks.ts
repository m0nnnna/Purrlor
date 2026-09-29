import type { MatrixClient } from 'matrix-js-sdk';
import { emotesFromPackContent, getRoomEmotesAtStateKey, type Emote, type RoomEmotesContent } from './emotes';

/**
 * MSC2545's *personal* side, read-only here: your own pack, wherever you're logged in from
 * (`im.ponies.user_emotes` account data), plus other rooms' packs you've explicitly subscribed to
 * (`im.ponies.emote_rooms`) independently of whether you're actually in that room or Space —
 * exactly the mechanism Element and Cinny use for "my emotes follow me everywhere." Both are
 * parsed with emotes.ts's `emotesFromPackContent`, the same MSC2545 parser room/Space packs use,
 * since the content shape is identical either way. This app doesn't offer a UI to *build* either
 * one (only EmoteManagerModal's room/Space/library packs) — this is purely for using what an
 * Element/Cinny user (or a future version of this app) already set up.
 */
export const USER_EMOTES_EVENT = 'im.ponies.user_emotes';
export const EMOTE_ROOMS_EVENT = 'im.ponies.emote_rooms';

export type PersonalPack = { name: string; emotes: Emote[] };

/** `{ rooms: { [roomId]: { [stateKey]: {} } } }` — each named state key is a pack in that room
 *  (MSC2545 allows more than one per room; this app's own EmoteManagerModal only ever writes
 *  `""`, but a subscription can point at any of them). The per-state-key value is spec'd as
 *  always `{}` — nothing here reads anything out of it. */
type EmoteRoomsContent = { rooms?: Record<string, Record<string, unknown>> };

/** Your own personal pack. Named "Personal" regardless of its own `pack.display_name` (which
 *  MSC2545 allows but Element and Cinny both ignore for this particular pack in their own UI,
 *  always just calling it "Personal" — this app follows suit for the same reason: it's the one
 *  pack that's unambiguously *yours*, so a per-pack name would be redundant at best). */
export function readOwnEmotePack(mx: MatrixClient): PersonalPack | undefined {
  const content = mx.getAccountData(USER_EMOTES_EVENT as any)?.getContent<RoomEmotesContent>();
  if (!content) return undefined;
  const emotes = emotesFromPackContent(content);
  return emotes.length > 0 ? { name: 'Personal', emotes } : undefined;
}

/** Every room pack you've subscribed to. A subscribed room you haven't joined/synced yet, or a
 *  named state key with no pack (or an empty one) at it, is silently left out rather than
 *  erroring — the same "narrow but honest" handling MessageTimeline's own ReplyPreview gives a
 *  reply to something not (yet) loaded. */
export function readSubscribedEmoteRoomPacks(mx: MatrixClient): PersonalPack[] {
  const rooms = mx.getAccountData(EMOTE_ROOMS_EVENT as any)?.getContent<EmoteRoomsContent>()?.rooms;
  if (!rooms || typeof rooms !== 'object') return [];

  const packs: PersonalPack[] = [];
  for (const [roomId, stateKeys] of Object.entries(rooms)) {
    const room = mx.getRoom(roomId);
    if (!room || !stateKeys || typeof stateKeys !== 'object') continue;
    for (const stateKey of Object.keys(stateKeys)) {
      const emotes = getRoomEmotesAtStateKey(room, stateKey);
      if (emotes.length === 0) continue;
      const displayName = room.currentState
        .getStateEvents('im.ponies.room_emotes', stateKey)
        ?.getContent<RoomEmotesContent>().pack?.display_name;
      packs.push({ name: displayName || room.name || 'Emote pack', emotes });
    }
  }
  return packs;
}

/** Both together, in the order the picker/reader's-set should show them: your own pack first,
 *  then whichever rooms' you've subscribed to. */
export function readPersonalEmotePacks(mx: MatrixClient): PersonalPack[] {
  const own = readOwnEmotePack(mx);
  return [...(own ? [own] : []), ...readSubscribedEmoteRoomPacks(mx)];
}
