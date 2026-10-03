import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { PROFILE_ROOM_TYPE } from './profileFeed';

/**
 * Mentioning someone in a **Global** post.
 *
 * A mention notifies through `m.mentions` (the spec's `.m.rule.is_user_mention`), but a homeserver
 * only delivers a room's events to the room's members, and the people you'd mention are almost
 * never members of your profile room. So after the post goes out, its author **invites** each
 * mentioned person who isn't in the room yet, with a reason that says why and names the post. An
 * invite notifies by default (`.m.rule.invite_for_me`), so it arrives in the app and by background
 * push, where the push gateway words it "Mentioned you in a post".
 *
 * The invitee's app accepts it by itself (MentionInviteAcceptor) and files the mention in their
 * Mention Inbox, so it never sits in the Invites list: it's a mention, not a room to decide about.
 * Only an invite to a *profile room*, from the person who created that room, carrying this reason,
 * is treated that way. Checked on Continuwuity: the invitee's `invite_state` carries both the room
 * type (on `m.room.create`) and the reason.
 */
export const MENTION_INVITE_MARKER = 'xyz.nekous.mention';

/** Readable in any client, and parseable by this one. Someone tagged in a picture is told so. */
export function mentionInviteReason(postId: string, tagged = false): string {
  return `${tagged ? 'Tagged you in a photo' : 'Mentioned you in a post'} (${MENTION_INVITE_MARKER} ${postId})`;
}

export function parseMentionInviteReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const match = /\(xyz\.nekous\.mention (\$[^\s)]+)\)/.exec(reason);
  return match?.[1];
}

/**
 * Invites everyone mentioned who isn't in the room already; those in `tagged` (tagged in a
 * picture, imageTags.ts) are told that instead. One failing doesn't stop the rest.
 */
export async function inviteMentioned(mx: MatrixClient, roomId: string, postId: string, userIds: string[], tagged: string[] = []): Promise<void> {
  const room = mx.getRoom(roomId);
  for (const userId of userIds) {
    const membership = room?.getMember(userId)?.membership;
    if (membership === 'join' || membership === 'ban' || userId === mx.getUserId()) continue;
    await mx.invite(roomId, userId, mentionInviteReason(postId, tagged.includes(userId))).catch(() => undefined);
  }
}

/**
 * The mention an invite carries, if it's one (see above): who mentioned you, and in which post.
 * Anything else — an ordinary invite, one to some other kind of room, one from someone who doesn't
 * own the room — is undefined, and stays an ordinary invite.
 */
export function readMentionInvite(mx: MatrixClient, room: Room): { inviter: string; postId: string; tagged: boolean } | undefined {
  const myUserId = mx.getUserId();
  if (!myUserId || room.getMyMembership() !== 'invite') return undefined;
  const create = room.currentState.getStateEvents(EventType.RoomCreate, '');
  if (create?.getContent().type !== PROFILE_ROOM_TYPE) return undefined;
  const invite = room.currentState.getStateEvents(EventType.RoomMember, myUserId);
  const reason: unknown = invite?.getContent().reason;
  const postId = parseMentionInviteReason(reason);
  const inviter = invite?.getSender();
  if (!postId || !inviter || inviter !== create.getSender()) return undefined;
  return { inviter, postId, tagged: typeof reason === 'string' && reason.startsWith('Tagged you in a photo') };
}
