import { describe, expect, it, vi } from 'vitest';
import { getExtendedProfile, isAnimatableImageType, updateExtendedProfile } from './extendedProfile';

function fakeClient(profile: Record<string, unknown> | Error) {
  const getExtendedProfileMock =
    profile instanceof Error ? vi.fn().mockRejectedValue(profile) : vi.fn().mockResolvedValue(profile);
  const setExtendedProfileProperty = vi.fn().mockResolvedValue(undefined);
  const deleteExtendedProfileProperty = vi.fn().mockResolvedValue(undefined);
  return {
    getExtendedProfile: getExtendedProfileMock,
    setExtendedProfileProperty,
    deleteExtendedProfileProperty,
  } as unknown as Parameters<typeof getExtendedProfile>[0] & {
    setExtendedProfileProperty: typeof setExtendedProfileProperty;
    deleteExtendedProfileProperty: typeof deleteExtendedProfileProperty;
  };
}

describe('isAnimatableImageType', () => {
  it('treats gif and webp as animatable', () => {
    expect(isAnimatableImageType('image/gif')).toBe(true);
    expect(isAnimatableImageType('image/webp')).toBe(true);
  });

  it('treats everything else as not animatable', () => {
    expect(isAnimatableImageType('image/png')).toBe(false);
    expect(isAnimatableImageType('image/jpeg')).toBe(false);
    expect(isAnimatableImageType('')).toBe(false);
  });
});

describe('getExtendedProfile', () => {
  it('picks out only the namespaced keys it recognizes', async () => {
    const mx = fakeClient({
      'xyz.nekous.bio': 'hello',
      'xyz.nekous.banner_url': 'mxc://example.org/banner',
      'xyz.nekous.avatar_animated': true,
      displayname: 'Someone', // a real global-profile field — not ours to read here
    });
    expect(await getExtendedProfile(mx, '@a:example.org')).toEqual({
      bio: 'hello',
      bannerUrl: 'mxc://example.org/banner',
      avatarAnimated: true,
    });
  });

  it('returns an empty object for a user with none of these set (or no MSC4133 support)', async () => {
    const mx = fakeClient(Object.assign(new Error('Not found'), { errcode: 'M_NOT_FOUND' }));
    expect(await getExtendedProfile(mx, '@a:example.org')).toEqual({});
  });

  it('gives what was read last time when their server doesn’t answer, and uses a recent copy without asking', async () => {
    await getExtendedProfile(fakeClient({ 'xyz.nekous.profile_room': '!p:far.example' }), '@far:far.example');
    const down = fakeClient(new Error('timeout'));
    expect((await getExtendedProfile(down, '@far:far.example')).profileRoom).toBe('!p:far.example');
    expect((await getExtendedProfile(down, '@nobody:far.example')).profileRoom).toBeUndefined();

    const asked = fakeClient({});
    expect((await getExtendedProfile(asked, '@far:far.example', { maxAgeMs: 60_000 })).profileRoom).toBe('!p:far.example');
    expect(asked.getExtendedProfile).not.toHaveBeenCalled();
  });

  it('ignores wrongly-typed values rather than passing them through', async () => {
    const mx = fakeClient({ 'xyz.nekous.bio': 12345, 'xyz.nekous.banner_url': null });
    expect(await getExtendedProfile(mx, '@a:example.org')).toEqual({ avatarAnimated: false });
  });
});

describe('updateExtendedProfile', () => {
  it('sets non-empty fields and deletes explicitly cleared ones, one call per key', async () => {
    const mx = fakeClient({});
    await updateExtendedProfile(mx, { bio: 'new bio', bannerUrl: null });
    expect(mx.setExtendedProfileProperty).toHaveBeenCalledWith('xyz.nekous.bio', 'new bio');
    expect(mx.deleteExtendedProfileProperty).toHaveBeenCalledWith('xyz.nekous.banner_url');
  });

  it('leaves omitted keys untouched entirely', async () => {
    const mx = fakeClient({});
    await updateExtendedProfile(mx, { bio: 'only this' });
    expect(mx.setExtendedProfileProperty).toHaveBeenCalledWith('xyz.nekous.bio', 'only this');
    expect(mx.setExtendedProfileProperty).toHaveBeenCalledTimes(1);
    expect(mx.deleteExtendedProfileProperty).not.toHaveBeenCalled();
  });

  it('only deletes, never sets, when every given field is a clear', async () => {
    const mx = fakeClient({});
    await updateExtendedProfile(mx, { bio: null, bannerUrl: '' });
    expect(mx.setExtendedProfileProperty).not.toHaveBeenCalled();
    expect(mx.deleteExtendedProfileProperty).toHaveBeenCalledWith('xyz.nekous.bio');
    expect(mx.deleteExtendedProfileProperty).toHaveBeenCalledWith('xyz.nekous.banner_url');
  });
});
