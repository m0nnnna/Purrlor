import { EventType, Preset, type MatrixClient, type Room } from 'matrix-js-sdk';
import { ENCRYPTION_INITIAL_STATE } from './encryption';
import { acceptInvite, classifyInvite } from './invites';
import { readMentionInvite } from './mentionInvites';
import { listSpacelessRooms } from './spacelessRooms';

const MXID_PATTERN = /^@[^:\s]+:.+$/;

export function isValidUserId(userId: string): boolean {
  return MXID_PATTERN.test(userId);
}

/**
 * Updates the `m.direct` account data mapping so other Matrix clients (Element etc.) also
 * recognize the new room as a DM with this user. This app's DM list doesn't depend on it (see
 * spacelessRooms.ts: a room counts as a DM here by "not in any joined Space"); it only breaks a
 * tie in findExistingDirectMessageRoomId, and keeps the room from looking like a stray group chat
 * elsewhere.
 */
async function recordAsDirectMessage(mx: MatrixClient, userId: string, roomId: string): Promise<void> {
  const content = mx.getAccountData(EventType.Direct)?.getContent() ?? {};
  const existing = content[userId] ?? [];
  if (existing.includes(roomId)) return;
  await mx.setAccountData(EventType.Direct, { ...content, [userId]: [...existing, roomId] });
}

/** Exactly you (joined) and them (joined, or invited and not yet accepted) — a DM you started
 *  only has you joined until they accept, and it's still that DM meanwhile. */
function isOneToOneWith(room: Room, myUserId: string, userId: string): boolean {
  const members = room.getMembers().filter((m) => m.membership === 'join' || m.membership === 'invite');
  return (
    members.length === 2 &&
    members.some((m) => m.userId === myUserId && m.membership === 'join') &&
    members.some((m) => m.userId === userId)
  );
}

/** An existing 1:1 DM room with this user, if one's already around — checked before starting a
 *  new one from a profile's "Message" button, so clicking it reopens the existing conversation
 *  instead of spawning a duplicate room. That includes one you started that they haven't
 *  accepted yet. Only rooms the DM list shows count (listSpacelessRooms): a Space's channel with
 *  just the two of you in it is not a DM, and matching on member count alone sent "Message" to
 *  some small Space's #general.
 *
 *  The client lazy-loads members (client.ts), so a DM you haven't opened this session may know
 *  only your own member event, and looked like a room of one: "Message" then started a new DM
 *  beside one you'd both been using. The sync summary's counts are right without the members, so
 *  rooms they put at two people (or that have no summary yet) have their members loaded first.
 *
 *  Of several, one they've accepted comes first, then one `m.direct` records for them, then the
 *  most recently active (listSpacelessRooms' order). */
export async function findExistingDirectMessageRoomId(mx: MatrixClient, userId: string): Promise<string | undefined> {
  const myUserId = mx.getUserId() ?? '';
  const possible = listSpacelessRooms(mx).filter(
    (room) =>
      room.currentState.getStateEvents(EventType.SpaceParent).length === 0 &&
      room.getJoinedMemberCount() + room.getInvitedMemberCount() <= 2
  );
  await Promise.all(possible.map((room) => room.loadMembersIfNeeded().catch(() => false)));
  const candidates = possible.filter((room) => isOneToOneWith(room, myUserId, userId));
  if (candidates.length < 2) return candidates[0]?.roomId;
  const recorded: unknown = mx.getAccountData(EventType.Direct)?.getContent()[userId];
  const recordedIds: unknown[] = Array.isArray(recorded) ? recorded : [];
  const rank = (room: Room) =>
    (room.getMember(userId)?.membership === 'join' ? 0 : 2) + (recordedIds.includes(room.roomId) ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b))[0].roomId;
}

/** A DM this user invited you to that you haven't accepted yet: the invite's `is_direct` flag,
 *  from them, and not a Space or channel or a Global-post mention's invite. */
export function findPendingDirectMessageInviteRoomId(mx: MatrixClient, userId: string): string | undefined {
  const myUserId = mx.getUserId() ?? '';
  return mx.getRooms().find((room) => {
    if (room.getMyMembership() !== 'invite' || classifyInvite(mx, room) !== 'dm' || readMentionInvite(mx, room)) return false;
    const invite = room.currentState.getStateEvents(EventType.RoomMember, myUserId);
    return invite?.getSender() === userId && invite.getContent().is_direct === true;
  })?.roomId;
}

/** The DM to open for "Message": the one you already have with them, else the one they've
 *  invited you to (accepted now, rather than starting a second one beside it), else a new one. */
export async function openDirectMessage(mx: MatrixClient, userId: string): Promise<string> {
  const existing = await findExistingDirectMessageRoomId(mx, userId);
  if (existing) return existing;
  const invited = findPendingDirectMessageInviteRoomId(mx, userId);
  if (invited) {
    await acceptInvite(mx, invited);
    await recordAsDirectMessage(mx, userId, invited).catch(() => {
      // As in createDirectMessage: a nicety.
    });
    return invited;
  }
  return createDirectMessage(mx, userId);
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

/**
 * "Leave conversation" on a DM: Matrix has no deleting a room, so this leaves it and forgets it,
 * which takes it and its history off your list and every device of yours. The other person keeps
 * their copy; a DM with no one else left in it is gone for good. Also dropped from `m.direct`, so
 * other apps don't keep listing it.
 */
export async function leaveDirectMessage(mx: MatrixClient, roomId: string): Promise<void> {
  await mx.leave(roomId);
  await mx.forget(roomId).catch(() => {
    // Forgetting only tidies the server's record of a room you've left.
  });
  const content = mx.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  if (!Object.values(content).some((ids) => Array.isArray(ids) && ids.includes(roomId))) return;
  const next = Object.fromEntries(
    Object.entries(content)
      .map(([user, ids]) => [user, Array.isArray(ids) ? ids.filter((id) => id !== roomId) : ids] as const)
      .filter(([, ids]) => !Array.isArray(ids) || ids.length > 0)
  );
  await mx.setAccountData(EventType.Direct, next).catch(() => {
    // As in recordAsDirectMessage: a nicety for other apps.
  });
}
