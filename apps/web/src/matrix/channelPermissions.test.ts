import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { governSpaces, moderatorsOnlyChanges, powerLevelsForPosting, syncedChannelUsers, syncedThresholds, writerRank } from './channelPermissions';

describe('powerLevelsForPosting', () => {
  it('raises posting to moderators but keeps reactions open', () => {
    const next = powerLevelsForPosting({ users: { '@a': 100 }, events: { 'm.room.name': 50 } }, 'moderators');
    expect(next).toEqual({ users: { '@a': 100 }, events_default: 50, events: { 'm.room.name': 50, 'm.reaction': 0 } });
  });

  it('opens it back up and drops the reaction override', () => {
    const next = powerLevelsForPosting({ events_default: 50, events: { 'm.reaction': 0, 'm.room.name': 50 } }, 'everyone');
    expect(next).toEqual({ events_default: 0, events: { 'm.room.name': 50 } });
  });
});

describe('syncedChannelUsers', () => {
  it('copies the Space moderators and admins in', () => {
    expect(syncedChannelUsers({ users: { '@me': 100 } }, { '@mod': 50, '@me': 100 }, 100)).toEqual({ '@me': 100, '@mod': 50 });
  });

  it('changes nothing when the channel already matches', () => {
    expect(syncedChannelUsers({ users: { '@me': 100, '@mod': 50 } }, { '@mod': 50, '@me': 100 }, 100)).toBeUndefined();
  });

  it('takes a demoted moderator back to the default', () => {
    expect(syncedChannelUsers({ users: { '@me': 100, '@old': 50 } }, { '@me': 100 }, 100)).toEqual({ '@me': 100 });
  });

  it('leaves muted and ordinary members alone', () => {
    expect(syncedChannelUsers({ users: { '@me': 100, '@muted': -1, '@vip': 10 } }, { '@me': 100 }, 100)).toBeUndefined();
  });

  it('never changes anyone at or above its own level, nor to it', () => {
    // A moderator can't make someone an admin, or touch another moderator.
    expect(syncedChannelUsers({ users: { '@me': 50, '@peer': 50 } }, { '@me': 50, '@boss': 100 }, 50)).toBeUndefined();
    expect(syncedChannelUsers({ users: { '@me': 100, '@admin2': 100 } }, { '@me': 100 }, 100)).toBeUndefined();
  });

  it('skips the channel’s own privileged creators', () => {
    expect(syncedChannelUsers({ users: {} }, { '@creator': 50 }, 100, ['@creator'])).toBeUndefined();
  });
});

describe('moderatorsOnlyChanges', () => {
  const members = [
    { userId: '@mod', membership: 'join' },
    { userId: '@member', membership: 'join' },
    { userId: '@invited', membership: 'invite' },
    { userId: '@gone', membership: 'leave' },
    { userId: '@bot', membership: 'join' },
  ];

  it('invites moderators who are in the Space but not the channel, and removes everyone else', () => {
    const space = ['@mod', '@member', '@invited', '@newmod', '@gone'];
    expect(moderatorsOnlyChanges(members, ['@mod', '@newmod', '@outsider'], space)).toEqual({
      invite: ['@newmod'],
      remove: ['@member', '@invited'],
    });
  });

  it('never removes someone outside the Space, or anyone listed to keep', () => {
    expect(moderatorsOnlyChanges(members, ['@mod'], ['@mod', '@member', '@bot'], ['@bot', '@member'])).toEqual({ invite: [], remove: [] });
    expect(moderatorsOnlyChanges(members, ['@mod'], ['@mod'])).toEqual({ invite: [], remove: [] });
  });
});

describe('writerRank', () => {
  it('orders everyone able to write by level, then user ID, the same on every client', () => {
    const levels = { '@zed': 100, '@amy': 100, '@mod': 50, '@me': 100 };
    expect(writerRank(levels, 100, '@amy')).toBe(0);
    expect(writerRank(levels, 100, '@me')).toBe(1);
    expect(writerRank(levels, 100, '@zed')).toBe(2);
    expect(writerRank(levels, 50, '@mod')).toBe(3);
  });
});

/** Just enough of a Room for the sync: state events by type and key. */
function fakeRoom(roomId: string, state: Record<string, Record<string, Record<string, unknown>>>, space = false): Room {
  const event = (type: string, key: string) =>
    state[type]?.[key] ? { getContent: () => state[type][key], getStateKey: () => key, getSender: () => '@me' } : null;
  return {
    roomId,
    isSpaceRoom: () => space,
    getMyMembership: () => 'join',
    getJoinedMembers: () => Object.keys(state['m.room.member'] ?? {}).map((userId) => ({ userId })),
    currentState: {
      getStateEvents: (type: string, key?: string) =>
        key === undefined ? Object.keys(state[type] ?? {}).map((k) => event(type, k)) : event(type, key),
    },
  } as unknown as Room;
}

describe('governSpaces', () => {
  const space = fakeRoom(
    '!space',
    {
      'm.room.power_levels': { '': { users: { '@me': 100, '@amy': 100, '@mod': 50 } } },
      'm.space.child': { '!a': { via: ['x'] }, '!b': { via: ['x'] }, '!c': { via: ['x'] } },
    },
    true
  );
  const channel = (id: string, users: Record<string, number>) => fakeRoom(id, { 'm.room.power_levels': { '': { users } } });
  const setup = (rooms: Room[]) => {
    const sendStateEvent = vi.fn(async (..._args: unknown[]) => ({}));
    const mx = {
      getUserId: () => '@me',
      getRoom: (id: string) => [space, ...rooms].find((r) => r.roomId === id) ?? null,
      getRooms: () => [space, ...rooms],
      sendStateEvent,
    } as unknown as MatrixClient;
    return { mx, sendStateEvent };
  };

  it('waits its turn behind admins ahead of it, paces its writes, and skips channels already in line', async () => {
    const { mx, sendStateEvent } = setup([
      channel('!a', { '@me': 100, '@amy': 100 }),
      channel('!b', { '@me': 100, '@amy': 100, '@mod': 50 }),
      channel('!c', { '@me': 100, '@amy': 100 }),
    ]);
    const wait = vi.fn(async (_ms: number) => {});
    await governSpaces(mx, undefined, { gapMs: 400, staggerMs: 20_000, wait });

    // @amy sorts before @me among the admins: one turn's wait, then a gap between the two writes.
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([20_000, 400]);
    expect(sendStateEvent.mock.calls.map(([roomId]) => roomId)).toEqual(['!a', '!c']);
    const content = (sendStateEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(content.users).toEqual({ '@me': 100, '@amy': 100, '@mod': 50 });
    expect(typeof content['xyz.nekous.role_sync']).toBe('number');
  });

  it('writes nothing, and waits for nothing, when every channel is already in line', async () => {
    const { mx, sendStateEvent } = setup([channel('!a', { '@me': 100, '@amy': 100, '@mod': 50 })]);
    const wait = vi.fn(async (_ms: number) => {});
    await governSpaces(mx, undefined, { wait });
    expect(wait).not.toHaveBeenCalled();
    expect(sendStateEvent).not.toHaveBeenCalled();
  });
});

describe('custom roles and channel moderators in the sync', () => {
  it('carries custom-role holders into channels and takes back a custom level the Space no longer gives', () => {
    const users = syncedChannelUsers({ users: { '@me': 100, '@gone': 25 } }, { '@me': 100, '@helper': 25 }, 100, [], { roleFloor: 25 });
    expect(users).toEqual({ '@me': 100, '@helper': 25 });
  });

  it('makes a channel’s own moderators moderators there, and never takes it back', () => {
    const opts = { roleFloor: 50, channelModerators: ['@chanmod', '@senior'] };
    expect(syncedChannelUsers({ users: { '@me': 100 } }, { '@me': 100, '@senior': 75 }, 100, [], opts)).toEqual({
      '@me': 100,
      '@chanmod': 50,
      '@senior': 75,
    });
    expect(syncedChannelUsers({ users: { '@me': 100, '@chanmod': 50 } }, { '@me': 100 }, 100, [], { channelModerators: ['@chanmod'] })).toBeUndefined();
  });

  it('copies the Space’s thresholds into a channel, only those this user may change', () => {
    const space = { redact: 25, kick: 50, events: { 'm.room.pinned_events': 25 } };
    expect(syncedThresholds({ redact: 50, events: { 'm.room.name': 50 } }, space, 100)).toEqual({
      redact: 25,
      events: { 'm.room.name': 50, 'm.room.pinned_events': 25 },
    });
    expect(syncedThresholds({ redact: 25, events: { 'm.room.pinned_events': 25 } }, space, 100)).toBeUndefined();
    // A moderator can't touch a threshold set above their own level.
    expect(syncedThresholds({ ban: 100 }, { ban: 50 }, 50)).toBeUndefined();
  });

  it('leaves who edits the Space’s news on the Space, not copied into its channels', () => {
    const space = { events: { 'xyz.nekous.space_news': 25 } };
    expect(syncedThresholds({ events: {} }, space, 100)).toBeUndefined();
  });
});
