import { beforeEach, describe, expect, it } from 'vitest';
import { followsBack, forgetFollowCache, verifiedFriends } from './topFriends';

/** A homeserver where each person's profile room says who they follow; `undefined` is no profile room. */
function world(follows: Record<string, string[] | undefined>) {
  return {
    getExtendedProfile: async (userId: string) => (follows[userId] ? { 'xyz.nekous.profile_room': `!room-${userId}` } : {}),
    getRoom: () => null,
    roomState: async (roomId: string) =>
      (follows[roomId.replace('!room-', '')] ?? []).map((followed) => ({
        type: 'xyz.nekous.follow',
        state_key: followed,
        content: { following: true },
      })),
  } as never;
}

beforeEach(() => forgetFollowCache());

describe('the Top 8 follow-back check', () => {
  it('shows only people whose own profile says they follow the owner, in the order picked', async () => {
    const mx = world({
      '@a:s': ['@owner:s'],
      '@b:s': ['@someone-else:s'],
      '@c:s': ['@owner:s', '@b:s'],
      '@d:s': undefined,
    });
    expect(await verifiedFriends(mx, '@owner:s', ['@c:s', '@b:s', '@d:s', '@a:s'])).toEqual(['@c:s', '@a:s']);
  });

  it('ignores an unfollow: state can not be deleted, so it is empty content', async () => {
    const mx = {
      getExtendedProfile: async () => ({ 'xyz.nekous.profile_room': '!r' }),
      getRoom: () => null,
      roomState: async () => [{ type: 'xyz.nekous.follow', state_key: '@owner:s', content: {} }],
    } as never;
    expect(await followsBack(mx, '@a:s', '@owner:s')).toBe(false);
  });

  it('is false when the profile can not be read, rather than a guess', async () => {
    const mx = {
      getExtendedProfile: async () => Promise.reject(new Error('down')),
      getRoom: () => null,
      roomState: async () => Promise.reject(new Error('down')),
    } as never;
    expect(await followsBack(mx, '@a:s', '@owner:s')).toBe(false);
  });
});
