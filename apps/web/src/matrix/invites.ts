import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { getParentSpace } from './voice';
import { canInviteToRoom } from './permissions';

export type InviteKind = 'space' | 'channel' | 'dm';

/** The Space a room names as its parent (`m.space.parent`), with the servers to join it through,
 *  whether or not this client knows that Space yet — someone invited to one channel of a Space on
 *  another instance isn't in the Space, so it isn't among their rooms. */
export function parentSpaceOf(room: Room): { roomId: string; via: string[] } | undefined {
  const events = room.currentState.getStateEvents(EventType.SpaceParent) as MatrixEvent[];
  const event = events.find((e) => !!e.getStateKey());
  if (!event) return undefined;
  const via = event.getContent<{ via?: unknown }>().via;
  return { roomId: event.getStateKey() as string, via: Array.isArray(via) ? via.filter((v): v is string => typeof v === 'string') : [] };
}

/**
 * Classifies a pending invite the same three-way way the rest of the app already sorts rooms
 * (server rail = Spaces, channel list children = channels, spaceless list = everything else) —
 * so an invite reads the same regardless of whether you've joined it yet. `m.space.parent` comes
 * in the limited `invite_room_state` a homeserver may send alongside the invite; one that omits
 * it means a channel invite shows as a "Direct Message" row instead. The parent Space need not be
 * one of yours: an invite to another instance's channel is still a channel.
 */
export function classifyInvite(mx: MatrixClient, room: Room): InviteKind {
  if (room.isSpaceRoom()) return 'space';
  return getParentSpace(mx, room) || parentSpaceOf(room) ? 'channel' : 'dm';
}

/**
 * Joins the room, and for a channel of a Space you aren't in, the Space too. Without the Space,
 * the channel had nothing to sit under, so it showed up among your Direct Messages (that list is
 * every room outside your Spaces, spacelessRooms.ts). The parent is read from the room's full
 * state, which only arrives on joining. Joining the Space is best effort: one that's invite-only
 * and didn't invite you can't be joined, and the channel is still yours either way.
 */
export async function acceptInvite(mx: MatrixClient, roomId: string): Promise<void> {
  await mx.joinRoom(roomId);
  const parent = await readParentSpace(mx, roomId);
  if (!parent || mx.getRoom(parent.roomId)?.getMyMembership() === 'join') return;
  const via = parent.via.length > 0 ? parent.via : [roomId.slice(roomId.indexOf(':') + 1)];
  await mx.joinRoom(parent.roomId, { viaServers: via }).catch(() => undefined);
}

async function readParentSpace(mx: MatrixClient, roomId: string): Promise<{ roomId: string; via: string[] } | undefined> {
  type StateEvent = { type?: string; state_key?: string; content?: { via?: unknown } };
  let state: StateEvent[];
  try {
    state = (await mx.roomState(roomId)) as StateEvent[];
  } catch {
    return undefined; // Best effort, like the Space join it's for.
  }
  const event = state.find((e) => e.type === EventType.SpaceParent && !!e.state_key);
  if (!event?.state_key) return undefined;
  const via = event.content?.via;
  return { roomId: event.state_key, via: Array.isArray(via) ? via.filter((v): v is string => typeof v === 'string') : [] };
}

/**
 * Invites someone to a channel, and to its Space when they aren't in it yet and you may invite
 * there. Matrix keeps the two memberships separate, so a channel-only invite left the person —
 * typically someone on another instance — with a channel outside any Space of theirs, filed under
 * Direct Messages. Resolves with whether the Space invite went out too.
 */
export async function inviteToChannel(mx: MatrixClient, room: Room, userId: string): Promise<{ space: boolean }> {
  // Someone already in the channel (invited here before this also covered the Space) can be
  // invited again just to bring them into the Space; the channel invite itself would be refused.
  const inChannel = room.getMember?.(userId)?.membership;
  if (inChannel !== 'join' && inChannel !== 'invite') await mx.invite(room.roomId, userId);
  const space = getParentSpace(mx, room);
  if (!space) return { space: false };
  const membership = space.getMember(userId)?.membership;
  if (membership === 'join' || membership === 'invite' || membership === 'ban') return { space: false };
  if (!canInviteToRoom(space, mx.getUserId() ?? '')) return { space: false };
  try {
    await mx.invite(space.roomId, userId);
    return { space: true };
  } catch {
    return { space: false };
  }
}

/** Matrix has one endpoint for both "leave a room you're in" and "reject an invite you haven't
 *  joined" — `/rooms/{roomId}/leave` — there's no separate decline call. */
export async function declineInvite(mx: MatrixClient, roomId: string): Promise<void> {
  await mx.leave(roomId);
}
