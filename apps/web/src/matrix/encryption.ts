import { EventType, type ICreateRoomStateEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import { canSendStateEvent } from './permissions';

/**
 * Turning end-to-end encryption on for a room: `m.room.encryption` with Megolm, the algorithm
 * every Matrix client speaks. The app already reads and sends in encrypted rooms (the SDK's Rust
 * crypto); this is only about making them. Matrix has no way to turn it off again — a room's
 * encryption event can be replaced but never removed, and clients refuse to downgrade — so
 * everywhere that turns it on for an existing room says so first.
 *
 * Where it's on by default (Element's choices): DMs (directMessages.ts), and private channels
 * (CreateChannelModal). Not public ones: encryption does little for a room anyone can join and
 * read, and it costs things that only work in the clear — webhooks (the service bot has no
 * encryption), report excerpts, search on the server.
 */

export const ENCRYPTION_CONTENT = { algorithm: 'm.megolm.v1.aes-sha2' };

/** For `createRoom`'s `initial_state`, so a room is encrypted from its first event. */
export const ENCRYPTION_INITIAL_STATE: ICreateRoomStateEvent = {
  type: EventType.RoomEncryption,
  state_key: '',
  content: ENCRYPTION_CONTENT,
};

export function isEncryptedRoom(room: Room): boolean {
  return !!room.currentState.getStateEvents(EventType.RoomEncryption, '');
}

export function canEnableEncryption(room: Room, userId: string): boolean {
  return !isEncryptedRoom(room) && canSendStateEvent(room, userId, EventType.RoomEncryption);
}

/** Irreversible: see the module comment. */
export async function enableEncryption(mx: MatrixClient, room: Room): Promise<void> {
  if (isEncryptedRoom(room)) return;
  await mx.sendStateEvent(room.roomId, EventType.RoomEncryption, ENCRYPTION_CONTENT as any, '');
}
