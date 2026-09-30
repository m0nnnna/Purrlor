import type { Room } from 'matrix-js-sdk';
import { looksLikeEmoteLibrary } from './emoteLibrary';
import { REVIEW_ROOM_TYPE } from './reports';

/**
 * Rooms the app keeps for its own purposes and never shows as a chat: the global emote library
 * (emoteLibrary.ts) and a Space's report review room (reports.ts). Left out of the room list,
 * Forward and "Add an existing channel", by their room type, which only their creator can set.
 */
export function isBackgroundRoom(room: Room): boolean {
  return looksLikeEmoteLibrary(room) || room.getType() === REVIEW_ROOM_TYPE;
}
