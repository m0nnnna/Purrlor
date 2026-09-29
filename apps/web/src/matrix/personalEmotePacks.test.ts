import { describe, expect, it } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import {
  EMOTE_ROOMS_EVENT,
  readOwnEmotePack,
  readPersonalEmotePacks,
  readSubscribedEmoteRoomPacks,
  USER_EMOTES_EVENT,
} from './personalEmotePacks';

function fakeRoom(name: string, packsByStateKey: Record<string, { display_name?: string; images: Record<string, unknown> }>): Room {
  return {
    name,
    currentState: {
      getStateEvents: (_type: string, stateKey: string) => {
        const pack = packsByStateKey[stateKey];
        return pack ? { getContent: () => ({ pack: { display_name: pack.display_name }, images: pack.images }) } : undefined;
      },
    },
  } as unknown as Room;
}

function fakeClient(accountData: Record<string, unknown>, rooms: Record<string, Room> = {}) {
  return {
    getAccountData: (type: string) => (type in accountData ? { getContent: () => accountData[type] } : undefined),
    getRoom: (roomId: string) => rooms[roomId] ?? null,
  } as unknown as MatrixClient;
}

describe('readOwnEmotePack', () => {
  it('reads the personal pack from im.ponies.user_emotes, always named "Personal"', () => {
    const mx = fakeClient({
      [USER_EMOTES_EVENT]: { pack: { display_name: 'someone else\'s name for it' }, images: { cat: { url: 'mxc://x/cat' } } },
    });
    expect(readOwnEmotePack(mx)).toEqual({ name: 'Personal', emotes: [{ shortcode: 'cat', mxcUrl: 'mxc://x/cat' }] });
  });

  it('returns nothing when there is no personal pack, or it has no images', () => {
    expect(readOwnEmotePack(fakeClient({}))).toBeUndefined();
    expect(readOwnEmotePack(fakeClient({ [USER_EMOTES_EVENT]: { images: {} } }))).toBeUndefined();
  });
});

describe('readSubscribedEmoteRoomPacks', () => {
  it('reads a subscribed room pack by its named state key, using its own display_name', () => {
    const room = fakeRoom('Some Room', { '': { display_name: 'Best Emotes', images: { dog: { url: 'mxc://x/dog' } } } });
    const mx = fakeClient({ [EMOTE_ROOMS_EVENT]: { rooms: { '!room:example.org': { '': {} } } } }, { '!room:example.org': room });
    expect(readSubscribedEmoteRoomPacks(mx)).toEqual([{ name: 'Best Emotes', emotes: [{ shortcode: 'dog', mxcUrl: 'mxc://x/dog' }] }]);
  });

  it("falls back to the room's own name when the pack has no display_name", () => {
    const room = fakeRoom('Some Room', { '': { images: { dog: { url: 'mxc://x/dog' } } } });
    const mx = fakeClient({ [EMOTE_ROOMS_EVENT]: { rooms: { '!room:example.org': { '': {} } } } }, { '!room:example.org': room });
    expect(readSubscribedEmoteRoomPacks(mx)[0].name).toBe('Some Room');
  });

  it('silently skips a subscribed room that has not been joined/synced', () => {
    const mx = fakeClient({ [EMOTE_ROOMS_EVENT]: { rooms: { '!gone:example.org': { '': {} } } } }, {});
    expect(readSubscribedEmoteRoomPacks(mx)).toEqual([]);
  });

  it('silently skips a named state key with no pack, or an empty one, there', () => {
    const room = fakeRoom('Some Room', { '': { images: {} } });
    const mx = fakeClient(
      { [EMOTE_ROOMS_EVENT]: { rooms: { '!room:example.org': { '': {}, missing: {} } } } },
      { '!room:example.org': room }
    );
    expect(readSubscribedEmoteRoomPacks(mx)).toEqual([]);
  });

  it('returns nothing when there is no emote_rooms subscription at all', () => {
    expect(readSubscribedEmoteRoomPacks(fakeClient({}))).toEqual([]);
  });
});

describe('readPersonalEmotePacks', () => {
  it('puts your own pack first, ahead of any subscribed room packs', () => {
    const room = fakeRoom('Some Room', { '': { images: { dog: { url: 'mxc://x/dog' } } } });
    const mx = fakeClient(
      {
        [USER_EMOTES_EVENT]: { images: { cat: { url: 'mxc://x/cat' } } },
        [EMOTE_ROOMS_EVENT]: { rooms: { '!room:example.org': { '': {} } } },
      },
      { '!room:example.org': room }
    );
    expect(readPersonalEmotePacks(mx).map((p) => p.name)).toEqual(['Personal', 'Some Room']);
  });
});
