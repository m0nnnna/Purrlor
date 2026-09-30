import { EventType, Preset, type MatrixClient } from 'matrix-js-sdk';
import { ENCRYPTION_INITIAL_STATE } from './encryption';

const MXID_PATTERN = /^@[^:\s]+:.+$/;

export function isValidUserId(userId: string): boolean {
  return MXID_PATTERN.test(userId);
}

/**
 * Updates the `m.direct` account data mapping so other Matrix clients (Element etc.) also
 * recognize the new room as a DM with this user — this app itself never reads it (see
 * useSpacelessRooms.ts: a room counts as a DM here purely by "not in any joined Space"), but
 * writing it costs nothing and keeps the room from looking like a stray group chat elsewhere.
 */
async function recordAsDirectMessage(mx: MatrixClient, userId: string, roomId: string): Promise<void> {
  const content = mx.getAccountData(EventType.Direct)?.getContent() ?? {};
  const existing = content[userId] ?? [];
  if (existing.includes(roomId)) return;
  await mx.setAccountData(EventType.Direct, { ...content, [userId]: [...existing, roomId] });
}

/** An existing 1:1 (exactly you + them, joined) DM room with this user, if one's already
 *  around — checked before starting a new one from a profile's "Message" button, so clicking it
 *  reopens the existing conversation instead of spawning a duplicate room. */
export function findExistingDirectMessageRoomId(mx: MatrixClient, userId: string): string | undefined {
  const myUserId = mx.getUserId();
  return mx.getRooms().find((room) => {
    if (room.isSpaceRoom()) return false;
    const joined = room.getJoinedMembers();
    return joined.length === 2 && joined.some((m) => m.userId === userId) && joined.some((m) => m.userId === myUserId);
  })?.roomId;
}

/**
 * Starts a new 1:1 DM by Matrix ID — there's no user-directory search here (that would need
 * `/user_directory/search`, debouncing, and handling homeservers that disable it entirely), so
 * like several other places in this app, this is deliberately the "type the exact ID" version
 * rather than a full people-picker. `trusted_private_chat` grants the invitee the same power
 * level as the creator, matching the convention other clients use for DMs. End-to-end encrypted
 * from the start, as Element does (encryption.ts): the preset alone doesn't do that, and neither
 * does Continuwuity by default (checked).
 */
export async function createDirectMessage(mx: MatrixClient, userId: string): Promise<string> {
  const result = await mx.createRoom({
    preset: Preset.TrustedPrivateChat,
    invite: [userId],
    is_direct: true,
    initial_state: [ENCRYPTION_INITIAL_STATE],
  });
  await recordAsDirectMessage(mx, userId, result.room_id).catch(() => {
    // Cross-client DM labeling is a nicety, not required for this app's own DM list to work.
  });
  return result.room_id;
}
