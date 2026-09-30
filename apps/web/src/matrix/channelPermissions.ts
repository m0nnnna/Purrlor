import { EventType, JoinRule, RestrictedAllowType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { privilegedCreators, userPowerLevel } from './permissions';
import { readOwnVoiceServerConfig } from './voice';

/**
 * Per-channel permissions on top of a Space's roles: who can post (everyone, or moderators — an
 * announcement channel), who can see the channel (everyone in the Space, or moderators), and
 * slowmode. docs/channel-permissions.md has the design; the short version:
 *
 * - **Roles reach the channels.** Matrix gives every room its own power levels and a Space's
 *   don't cascade, so a Space moderator had no power in the Space's channels unless whoever made
 *   each channel had set it up by hand. The client of anyone who can change a channel's power
 *   levels now copies the Space's moderators and admins into it (governChannel), the way
 *   feedGovernance.ts does for feeds. Everything below leans on this.
 * - **Posting** is the channel's own power levels, so the homeserver enforces it: "Moderators"
 *   raises `events_default` to the moderator level, keeping reactions at 0.
 * - **Visibility** "Moderators" makes the channel invite-only, invites the Space's moderators and
 *   removes everyone else. The homeserver keeps it out of the Space's hierarchy for anyone not in
 *   it (checked on Continuwuity), so to everyone else it simply isn't there.
 * - **Slowmode** has no Matrix equivalent. It's a state event this app's composer honours for
 *   people below moderator; other clients don't know about it, so it's a speed bump, not a wall.
 */

export const CHANNEL_SETTINGS_EVENT = 'xyz.nekous.channel_settings';

/** Moderator and above, the same line as roles.ts's "Moderator". */
export const MODERATOR_LEVEL = 50;

export type PostingMode = 'everyone' | 'moderators';
export type Visibility = 'space' | 'moderators';

export type ChannelPermissions = { posting: PostingMode; visibility: Visibility; slowmodeSeconds: number };

type PowerLevels = {
  users?: Record<string, number>;
  users_default?: number;
  events?: Record<string, number>;
  events_default?: number;
  state_default?: number;
  [key: string]: unknown;
};

type SettingsContent = { moderators_only?: unknown; slowmode_seconds?: unknown };

function powerLevels(room: Room): PowerLevels {
  return room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<PowerLevels>() ?? {};
}

function settingsContent(room: Room): SettingsContent {
  return room.currentState.getStateEvents(CHANNEL_SETTINGS_EVENT, '')?.getContent<SettingsContent>() ?? {};
}

export function readChannelPermissions(room: Room): ChannelPermissions {
  const settings = settingsContent(room);
  const seconds = settings.slowmode_seconds;
  return {
    posting: (powerLevels(room).events_default ?? 0) >= MODERATOR_LEVEL ? 'moderators' : 'everyone',
    visibility: settings.moderators_only === true ? 'moderators' : 'space',
    slowmodeSeconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0,
  };
}

// --- Posting ---------------------------------------------------------------------------------

/** The power levels for a posting mode. Pure, so it's tested directly. */
export function powerLevelsForPosting(current: PowerLevels, mode: PostingMode): PowerLevels {
  const events = { ...current.events };
  if (mode === 'moderators') {
    // Everyone can still react — an announcement is still something people respond to.
    events[EventType.Reaction] = 0;
    return { ...current, events_default: MODERATOR_LEVEL, events };
  }
  delete events[EventType.Reaction];
  return { ...current, events_default: 0, events };
}

export async function setPostingMode(mx: MatrixClient, room: Room, mode: PostingMode): Promise<void> {
  await mx.sendStateEvent(room.roomId, EventType.RoomPowerLevels, powerLevelsForPosting(powerLevels(room), mode) as any, '');
}

/** Whether someone can post plain messages here. */
export function canPostMessages(room: Room, userId: string): boolean {
  const levels = powerLevels(room);
  const required = levels.events?.[EventType.RoomMessage] ?? levels.events_default ?? 0;
  return userPowerLevel(room, userId) >= required;
}

// --- Slowmode --------------------------------------------------------------------------------

export async function setSlowmode(mx: MatrixClient, room: Room, seconds: number): Promise<void> {
  const current = room.currentState.getStateEvents(CHANNEL_SETTINGS_EVENT, '')?.getContent<Record<string, unknown>>() ?? {};
  const next = { ...current, slowmode_seconds: seconds > 0 ? Math.floor(seconds) : undefined };
  await mx.sendStateEvent(room.roomId, CHANNEL_SETTINGS_EVENT as any, next as any, '');
}

/** Moderators aren't slowed down, as on Discord. */
export function isExemptFromSlowmode(room: Room, userId: string): boolean {
  return userPowerLevel(room, userId) >= MODERATOR_LEVEL;
}

/**
 * How many more milliseconds `userId` has to wait before posting again, from their latest
 * message in what's loaded of the timeline. 0 when they can post now.
 */
export function slowmodeWaitMs(room: Room, userId: string, now = Date.now()): number {
  const { slowmodeSeconds } = readChannelPermissions(room);
  if (slowmodeSeconds === 0 || isExemptFromSlowmode(room, userId)) return 0;
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.getSender() !== userId) continue;
    const type = event.getType();
    if (type !== EventType.RoomMessage && type !== EventType.RoomMessageEncrypted && type !== EventType.Sticker) continue;
    return Math.max(0, event.getTs() + slowmodeSeconds * 1000 - now);
  }
  return 0;
}

// --- Roles from the Space --------------------------------------------------------------------

/** Everyone at moderator or above in the Space, with their level; a v12 creator counts as 100. */
export function spaceRoleLevels(space: Room): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const [userId, level] of Object.entries(powerLevels(space).users ?? {})) {
    if (typeof level === 'number' && level >= MODERATOR_LEVEL) levels[userId] = Math.min(level, 100);
  }
  for (const creator of privilegedCreators(space)) levels[creator] = 100;
  return levels;
}

/**
 * A channel's `users` power levels with the Space's moderators and admins copied in, or
 * undefined when nothing changes. Only touches what `myLevel` is allowed to (a level below it,
 * to a level below it), leaves anyone below moderator in the channel alone (a muted member, say),
 * and never touches the channel's own privileged creators. Someone who's a moderator in the
 * channel but not in the Space goes back to the default: roles come from the Space. Pure.
 */
export function syncedChannelUsers(
  channel: PowerLevels,
  spaceLevels: Record<string, number>,
  myLevel: number,
  channelCreators: string[] = []
): Record<string, number> | undefined {
  const users = { ...channel.users };
  const defaultLevel = channel.users_default ?? 0;
  let changed = false;
  const canChange = (from: number, to: number) => from < myLevel && to < myLevel;

  for (const [userId, level] of Object.entries(spaceLevels)) {
    if (channelCreators.includes(userId)) continue;
    const current = users[userId] ?? defaultLevel;
    if (current !== level && canChange(current, level)) {
      users[userId] = level;
      changed = true;
    }
  }
  for (const [userId, level] of Object.entries(users)) {
    if (spaceLevels[userId] !== undefined || channelCreators.includes(userId)) continue;
    if (level >= MODERATOR_LEVEL && canChange(level, defaultLevel)) {
      delete users[userId];
      changed = true;
    }
  }
  return changed ? users : undefined;
}

// --- Moderators-only channels ----------------------------------------------------------------

type Membership = { userId: string; membership: string };

/** Who to invite into a moderators-only channel and who to remove. Pure. */
export function moderatorsOnlyChanges(
  members: Membership[],
  moderators: string[],
  spaceMembers: string[],
  keep: string[] = []
): { invite: string[]; remove: string[] } {
  const inRoom = (userId: string) => members.some((m) => m.userId === userId && (m.membership === 'join' || m.membership === 'invite'));
  const isModerator = new Set(moderators);
  return {
    invite: moderators.filter((userId) => !inRoom(userId) && spaceMembers.includes(userId)),
    // Only Space members who aren't moderators: someone who isn't in the Space at all (the voice
    // channel's service bot, say) was let in for another reason.
    remove: members
      .filter((m) => (m.membership === 'join' || m.membership === 'invite') && !isModerator.has(m.userId))
      .map((m) => m.userId)
      .filter((userId) => spaceMembers.includes(userId) && !keep.includes(userId)),
  };
}

/** Makes a channel moderators-only, or opens it back up to everyone in its Space. */
export async function setVisibility(mx: MatrixClient, channel: Room, space: Room, visibility: Visibility): Promise<void> {
  const current = channel.currentState.getStateEvents(CHANNEL_SETTINGS_EVENT, '')?.getContent<Record<string, unknown>>() ?? {};
  const moderatorsOnly = visibility === 'moderators';
  // The join rule first: if the settings event said "moderators only" before the room actually
  // was, someone could read the flag and wander in through the old rule in between.
  if (moderatorsOnly) {
    await mx.sendStateEvent(channel.roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Invite } as any, '');
  } else {
    await mx.sendStateEvent(
      channel.roomId,
      EventType.RoomJoinRules,
      { join_rule: JoinRule.Restricted, allow: [{ type: RestrictedAllowType.RoomMembership, room_id: space.roomId }] } as any,
      ''
    );
  }
  await mx.sendStateEvent(channel.roomId, CHANNEL_SETTINGS_EVENT as any, { ...current, moderators_only: moderatorsOnly || undefined } as any, '');
  if (moderatorsOnly) await governChannel(mx, channel, space);
}

// --- Keeping channels in line with their Space ----------------------------------------------

function canSendState(room: Room, userId: string, type: string): boolean {
  const levels = powerLevels(room);
  return userPowerLevel(room, userId) >= (levels.events?.[type] ?? levels.state_default ?? 50);
}

function actionLevel(room: Room, action: 'invite' | 'kick'): number {
  const value = powerLevels(room)[action];
  return typeof value === 'number' ? value : action === 'invite' ? 0 : 50;
}

/**
 * Brings one channel in line with its Space, as far as this user is allowed to: the Space's
 * roles into its power levels, then, for a moderators-only channel, its members. Changes nothing
 * when it's already in line, so it's cheap to run whenever the Space changes.
 */
export async function governChannel(mx: MatrixClient, channel: Room, space: Room): Promise<void> {
  const myUserId = mx.getUserId();
  if (!myUserId || channel.getMyMembership() !== 'join') return;
  const myLevel = userPowerLevel(channel, myUserId);
  const spaceLevels = spaceRoleLevels(space);

  if (canSendState(channel, myUserId, EventType.RoomPowerLevels)) {
    const current = powerLevels(channel);
    const users = syncedChannelUsers(current, spaceLevels, myLevel, privilegedCreators(channel));
    if (users) await mx.sendStateEvent(channel.roomId, EventType.RoomPowerLevels, { ...current, users } as any, '');
  }

  if (readChannelPermissions(channel).visibility !== 'moderators') return;
  const members = (channel.currentState.getStateEvents(EventType.RoomMember) as MatrixEvent[]).map((event) => ({
    userId: event.getStateKey() ?? '',
    membership: event.getContent<{ membership?: string }>().membership ?? 'leave',
  }));
  const spaceMembers = space.getJoinedMembers().map((member) => member.userId);
  // Never removed: yourself, the channel's creators, and the Space's voice service bot, which a
  // voice channel needs in the room to let anyone into the call (voiceBot.ts).
  const botUserId = readOwnVoiceServerConfig(space)?.botUserId;
  const { invite, remove } = moderatorsOnlyChanges(members, Object.keys(spaceLevels), spaceMembers, [
    myUserId,
    ...privilegedCreators(channel),
    ...(botUserId ? [botUserId] : []),
  ]);
  if (myLevel >= actionLevel(channel, 'invite')) {
    for (const userId of invite) await mx.invite(channel.roomId, userId).catch(() => undefined);
  }
  if (myLevel >= actionLevel(channel, 'kick')) {
    for (const userId of remove) {
      if (userPowerLevel(channel, userId) >= myLevel) continue;
      await mx.kick(channel.roomId, userId, 'This channel is for moderators').catch(() => undefined);
    }
  }
}

/** The joined channels of a joined Space. */
export function spaceChannels(mx: MatrixClient, space: Room): Room[] {
  return (space.currentState.getStateEvents(EventType.SpaceChild) as MatrixEvent[])
    .filter((event) => {
      const via = event.getContent<{ via?: unknown }>().via;
      return Array.isArray(via) && via.length > 0;
    })
    .flatMap((event) => mx.getRoom(event.getStateKey() ?? '') ?? [])
    .filter((room) => !room.isSpaceRoom() && room.getMyMembership() === 'join');
}

/** governChannel for every channel of the given Spaces (all joined Spaces when omitted). */
export async function governSpaces(mx: MatrixClient, spaceIds?: Iterable<string>): Promise<void> {
  const spaces = spaceIds
    ? [...spaceIds].flatMap((id) => mx.getRoom(id) ?? [])
    : mx.getRooms().filter((room) => room.isSpaceRoom());
  for (const space of spaces) {
    if (space.getMyMembership() !== 'join') continue;
    for (const channel of spaceChannels(mx, space)) {
      try {
        await governChannel(mx, channel, space);
      } catch (err) {
        console.warn(`Couldn’t bring ${channel.roomId} in line with its Space`, err);
      }
    }
  }
}

/**
 * The Space whose moderator invited you to this channel of it, if that's what this invite is.
 * Those are accepted without asking: it's how a moderators-only channel reaches a new moderator.
 * Anything else still waits in Invites.
 */
export function inviteFromSpaceModerator(mx: MatrixClient, room: Room): Room | undefined {
  const myUserId = mx.getUserId();
  if (!myUserId || room.getMyMembership() !== 'invite') return undefined;
  const inviter = room.getMember(myUserId)?.events.member?.getSender();
  if (!inviter) return undefined;
  return mx
    .getRooms()
    .find(
      (space) =>
        space.isSpaceRoom() &&
        space.getMyMembership() === 'join' &&
        (space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent<{ via?: unknown }>().via as unknown[] | undefined)
          ?.length &&
        (spaceRoleLevels(space)[inviter] ?? 0) >= MODERATOR_LEVEL
    );
}
