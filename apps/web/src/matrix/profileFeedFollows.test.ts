import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { followedUserId, followStateKey, publishFollow, readProfileFollows, republishFollows } from './profileFeed';

const ROOM = '!profile:s';

/** A client whose profile room holds `follows` (state key → content), recording what it sends. */
function fakeClient(follows: Record<string, Record<string, unknown>>) {
  const sent: { type: string; content: unknown; stateKey: string }[] = [];
  const events = Object.entries(follows).map(([stateKey, content]) => ({
    getType: () => 'xyz.nekous.follow',
    getStateKey: () => stateKey,
    getContent: () => content,
  }));
  const mx = {
    getUserId: () => '@me:s',
    getAccountData: (type: string) => (type === 'xyz.nekous.profile_room' ? { getContent: () => ({ roomId: ROOM }) } : undefined),
    getRoom: (roomId: string) =>
      roomId === ROOM ? { getMyMembership: () => 'join', currentState: { getStateEvents: () => events } } : null,
    sendStateEvent: vi.fn(async (_room: string, type: string, content: unknown, stateKey: string) => {
      sent.push({ type, content, stateKey });
      return { event_id: '$x' };
    }),
  } as unknown as MatrixClient;
  return { mx, sent };
}

describe('follow state keys', () => {
  it("never starts with @, which homeservers keep for that user's own state", () => {
    expect(followStateKey('@nibbles:purr.example')).toBe('nibbles:purr.example');
  });

  it('reads either form back as the user ID', () => {
    expect(followedUserId('nibbles:purr.example')).toBe('@nibbles:purr.example');
    expect(followedUserId('@nibbles:purr.example')).toBe('@nibbles:purr.example');
    expect(followedUserId('not a user')).toBeUndefined();
    expect(followedUserId('')).toBeUndefined();
  });

  it('lists who a profile follows, once each', () => {
    expect(
      readProfileFollows([
        { type: 'xyz.nekous.follow', state_key: 'a:s', content: { following: true } },
        { type: 'xyz.nekous.follow', state_key: '@a:s', content: { following: true } },
        { type: 'xyz.nekous.follow', state_key: 'b:s', content: {} },
        { type: 'xyz.nekous.follow', state_key: 'bad key', content: { following: true } },
      ])
    ).toEqual(['@a:s']);
  });
});

describe('publishing follows', () => {
  it('publishes under a key the homeserver accepts', async () => {
    const { mx, sent } = fakeClient({});
    await publishFollow(mx, '@them:s', false, 'Me');
    expect(sent).toEqual([{ type: 'xyz.nekous.follow', content: {}, stateKey: 'them:s' }]);
  });

  it('puts follows the profile is missing on it, and leaves the rest', async () => {
    const { mx, sent } = fakeClient({ 'a:s': { following: true } });
    expect(await republishFollows(mx, ['@a:s', '@b:s', 'junk'])).toBe(1);
    expect(sent).toEqual([{ type: 'xyz.nekous.follow', content: { following: true }, stateKey: 'b:s' }]);
  });
});
