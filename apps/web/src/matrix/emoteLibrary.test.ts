import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import {
  addLibraryImage,
  canMuteInLibrary,
  EMOTE_LIBRARY_ROOM_TYPE,
  EMOTE_MODERATION_EVENT,
  getLibraryEmotes,
  getLibraryStickers,
  isEmoteLibraryRoom,
  isMutedInLibrary,
  LIBRARY_MAX_IMAGES_PER_PERSON,
  readLibraryPacks,
  visibleLibraryImages,
} from './emoteLibrary';

const PACK = 'im.ponies.room_emotes';
const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';
const MOD = '@mod:example.org';

type FakeState = { type: string; stateKey: string; sender: string; content: Record<string, unknown>; ts?: number };

function fakeEvent(state: FakeState) {
  return {
    getType: () => state.type,
    getStateKey: () => state.stateKey,
    getSender: () => state.sender,
    getContent: () => state.content,
    getTs: () => state.ts ?? 0,
    getId: () => `$${state.type}-${state.stateKey}`,
  };
}

/** The library's power levels: packs at 0, moderation and power levels at 50. */
const POWER_LEVELS: FakeState = {
  type: 'm.room.power_levels',
  stateKey: '',
  sender: MOD,
  content: {
    users: { [MOD]: 50 },
    users_default: 0,
    events: { [PACK]: 0, [EMOTE_MODERATION_EVENT]: 50, 'm.room.power_levels': 50 },
  },
};

function fakeRoom(states: FakeState[], extra: Partial<Record<'type' | 'alias', string>> = {}) {
  const overridesPowerLevels = states.some((s) => s.type === POWER_LEVELS.type);
  const events = [...(overridesPowerLevels ? [] : [POWER_LEVELS]), ...states].map(fakeEvent);
  return {
    roomId: '!library:example.org',
    getType: () => extra.type,
    // The library's own alias unless a test says otherwise: whose packs count follows its server.
    getCanonicalAlias: () => ('alias' in extra ? (extra.alias ?? null) : '#purrlor-emotes:example.org'),
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        const ofType = events.filter((e) => e.getType() === type);
        return stateKey === undefined ? ofType : ofType.find((e) => e.getStateKey() === stateKey);
      },
    },
  } as unknown as Room;
}

function pack(owner: string, images: Record<string, Record<string, unknown>>, sender = owner): FakeState {
  return { type: PACK, stateKey: owner, sender, content: { images } };
}

const image = (url: string, addedAt: number, usage?: string[]) => ({
  url,
  ...(usage && { usage }),
  'xyz.nekous.added_at': addedAt,
});

describe('readLibraryPacks', () => {
  it("only reads packs stored under their sender's own user ID", () => {
    const room = fakeRoom([
      pack(ALICE, { cat: image('mxc://x/cat', 1) }),
      // Anyone at level 0 can write a pack under a key that isn't a user ID.
      { type: PACK, stateKey: '', sender: BOB, content: { images: { dog: image('mxc://x/dog', 1) } } },
      { type: PACK, stateKey: 'official', sender: BOB, content: { images: { owl: image('mxc://x/owl', 1) } } },
    ]);
    expect(readLibraryPacks(room).map((p) => p.owner)).toEqual([ALICE]);
  });

  it('ignores packs from people on other servers, who can join the library but not add to it', () => {
    const room = fakeRoom([pack(ALICE, { cat: image('mxc://x/cat', 1) }), pack('@mallory:evil.example', { evil: image('mxc://evil/x', 0) })]);
    expect(readLibraryPacks(room).map((p) => p.owner)).toEqual([ALICE]);
    expect(getLibraryEmotes(room).map((e) => e.shortcode)).toEqual(['cat']);
  });

  it('skips images without an mxc URL, and packs a moderator emptied', () => {
    const room = fakeRoom([
      pack(ALICE, { bad: { url: 'https://evil.example/x.png' }, ok: image('mxc://x/ok', 1) }),
      { type: PACK, stateKey: BOB, sender: BOB, content: {} },
    ]);
    const packs = readLibraryPacks(room);
    expect(packs).toHaveLength(1);
    expect(packs[0].images.map((i) => i.shortcode)).toEqual(['ok']);
  });
});

describe('visibleLibraryImages', () => {
  it('gives a shared shortcode to whoever added it first', () => {
    const room = fakeRoom([pack(ALICE, { cat: image('mxc://x/alice-cat', 20) }), pack(BOB, { cat: image('mxc://x/bob-cat', 10) })]);
    expect(visibleLibraryImages(room).map((i) => i.mxcUrl)).toEqual(['mxc://x/bob-cat']);
  });

  it("leaves hidden images out, so the next one with that shortcode shows instead", () => {
    const room = fakeRoom([
      pack(ALICE, { cat: image('mxc://x/alice-cat', 20) }),
      pack(BOB, { cat: image('mxc://x/bob-cat', 10) }),
      { type: EMOTE_MODERATION_EVENT, stateKey: '', sender: MOD, content: { hidden: ['mxc://x/bob-cat'] } },
    ]);
    expect(visibleLibraryImages(room).map((i) => i.mxcUrl)).toEqual(['mxc://x/alice-cat']);
    expect(readLibraryPacks(room).find((p) => p.owner === BOB)?.images[0].hidden).toBe(true);
  });

  it('splits emotes from stickers by usage, no usage meaning emote', () => {
    const room = fakeRoom([
      pack(ALICE, {
        plain: image('mxc://x/plain', 1),
        sticky: image('mxc://x/sticky', 1, ['sticker']),
        both: image('mxc://x/both', 1, ['emoticon', 'sticker']),
      }),
    ]);
    expect(getLibraryEmotes(room).map((e) => e.shortcode).sort()).toEqual(['both', 'plain']);
    expect(getLibraryStickers(room).map((s) => s.shortcode).sort()).toEqual(['both', 'sticky']);
  });
});

describe('permissions', () => {
  it('treats a power level below 0 as muted', () => {
    const room = fakeRoom([{ ...POWER_LEVELS, content: { ...POWER_LEVELS.content, users: { [MOD]: 50, [BOB]: -1 } } }]);
    expect(isMutedInLibrary(room, ALICE)).toBe(false);
    expect(isMutedInLibrary(room, BOB)).toBe(true);
  });

  it('lets a moderator mute people they outrank, but not other moderators or themselves', () => {
    const room = fakeRoom([
      { ...POWER_LEVELS, content: { ...POWER_LEVELS.content, users: { [MOD]: 50, [BOB]: 50 } } },
    ]);
    expect(canMuteInLibrary(room, MOD, ALICE)).toBe(true);
    expect(canMuteInLibrary(room, MOD, BOB)).toBe(false);
    expect(canMuteInLibrary(room, MOD, MOD)).toBe(false);
    expect(canMuteInLibrary(room, ALICE, BOB)).toBe(false);
  });
});

describe('isEmoteLibraryRoom', () => {
  it("needs both the room type and this server's alias", () => {
    expect(isEmoteLibraryRoom(fakeRoom([], { type: EMOTE_LIBRARY_ROOM_TYPE, alias: '#purrlor-emotes:example.org' }), 'example.org')).toBe(true);
    expect(isEmoteLibraryRoom(fakeRoom([], { type: EMOTE_LIBRARY_ROOM_TYPE, alias: '#purrlor-emotes:other.org' }), 'example.org')).toBe(false);
    expect(isEmoteLibraryRoom(fakeRoom([], { alias: '#purrlor-emotes:example.org' }), 'example.org')).toBe(false);
  });
});

describe('addLibraryImage', () => {
  function fakeClient() {
    const sendStateEvent = vi.fn().mockResolvedValue({});
    const mx = { getUserId: () => ALICE, getUser: () => ({ displayName: 'Alice' }), sendStateEvent } as unknown as MatrixClient;
    return { mx, sendStateEvent };
  }

  it("adds to the sender's own pack, keeping what's there", async () => {
    const { mx, sendStateEvent } = fakeClient();
    const room = fakeRoom([pack(ALICE, { cat: image('mxc://x/cat', 1) })]);
    await addLibraryImage(mx, room, 'dog', 'mxc://x/dog', ['emoticon']);
    const [roomId, type, content, stateKey] = sendStateEvent.mock.calls[0];
    expect([roomId, type, stateKey]).toEqual([room.roomId, PACK, ALICE]);
    expect(Object.keys(content.images)).toEqual(['cat', 'dog']);
    expect(content.images.dog).toMatchObject({ url: 'mxc://x/dog', usage: ['emoticon'] });
    expect(typeof content.images.dog['xyz.nekous.added_at']).toBe('number');
  });

  it('refuses a shortcode someone else already has', async () => {
    const { mx, sendStateEvent } = fakeClient();
    const room = fakeRoom([pack(BOB, { cat: image('mxc://x/cat', 1) })]);
    await expect(addLibraryImage(mx, room, 'cat', 'mxc://x/mine', ['emoticon'])).rejects.toThrow(/already/);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses past the per-person limit', async () => {
    const { mx } = fakeClient();
    const full = Object.fromEntries(
      Array.from({ length: LIBRARY_MAX_IMAGES_PER_PERSON }, (_, i) => [`e${i}`, image(`mxc://x/${i}`, i)])
    );
    await expect(addLibraryImage(mx, fakeRoom([pack(ALICE, full)]), 'one_more', 'mxc://x/new', ['emoticon'])).rejects.toThrow(
      /up to/
    );
  });
});
