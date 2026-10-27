import type { Room } from 'matrix-js-sdk';
import { looksLikeEmoteLibrary } from './emoteLibrary';
import { isStreamChatRoom } from './liveStream';
import { REVIEW_ROOM_TYPE } from './reports';

/**
 * Rooms the app keeps for its own purposes and never shows as a chat: the global emote library
 * (emoteLibrary.ts), a Space's report review room (reports.ts), and a live stream's chat, which
 * is shown beside its stream (docs/streaming.md). Left out of the room list, Forward and "Add an
 * existing channel"; the first two by their room type, which only their creator can set, a
 * stream's chat by the state the token server's bot gives it.
 */
export function isBackgroundRoom(room: Room): boolean {
  return looksLikeEmoteLibrary(room) || room.getType() === REVIEW_ROOM_TYPE || isStreamChatRoom(room);
}
