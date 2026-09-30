import { describe, expect, it } from 'vitest';
import { moderatorsOnlyChanges, powerLevelsForPosting, syncedChannelUsers } from './channelPermissions';

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
