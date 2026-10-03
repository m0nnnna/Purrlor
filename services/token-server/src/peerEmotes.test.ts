import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLibraryOf, libraryImages } from './peerEmotes.js';
import type { RawEvent } from './publicWeb.js';

const SERVER = 'cats.example';
const MOCHI = '@mochi:cats.example';
const LUNA = '@luna:cats.example';

const pack = (owner: string, images: Record<string, unknown>, sender = owner, ts = 1): RawEvent => ({
  type: 'im.ponies.room_emotes',
  state_key: owner,
  sender,
  origin_server_ts: ts,
  content: { images },
});

describe("a peer's emote library", () => {
  it('is recognised by its type and the alias its own server vouches for', () => {
    const create = { type: 'm.room.create', state_key: '', sender: '@admin:cats.example', content: { type: 'xyz.nekous.emote_library' } };
    const alias = { type: 'm.room.canonical_alias', state_key: '', content: { alias: '#purrlor-emotes:cats.example' } };
    assert.equal(isLibraryOf([create, alias], SERVER), true);
    assert.equal(isLibraryOf([create, alias], 'dogs.example'), false);
    assert.equal(isLibraryOf([{ ...create, content: {} }, alias], SERVER), false);
    assert.equal(isLibraryOf([create], SERVER), false);
  });

  it("reads each person's own pack, emotes and stickers, earliest shortcode first", () => {
    const images = libraryImages(
      [
        pack(MOCHI, {
          wave: { url: 'mxc://cats.example/wave', 'xyz.nekous.added_at': 5 },
          stamp: { url: 'mxc://cats.example/stamp', usage: ['sticker'], body: 'A stamp' },
          both: { url: 'mxc://cats.example/both', usage: ['emoticon', 'sticker'] },
        }),
        pack(LUNA, { wave: { url: 'mxc://cats.example/wave2', 'xyz.nekous.added_at': 3 } }),
      ],
      SERVER
    );
    assert.deepEqual(images, [
      { shortcode: 'both', url: 'mxc://cats.example/both', body: 'both', emoticon: true, sticker: true },
      { shortcode: 'stamp', url: 'mxc://cats.example/stamp', body: 'A stamp', emoticon: false, sticker: true },
      { shortcode: 'wave', url: 'mxc://cats.example/wave2', body: 'wave', emoticon: true, sticker: false },
    ]);
  });

  it("ignores packs from people on other servers, packs under someone else's ID, and hidden or bad images", () => {
    const images = libraryImages(
      [
        pack('@mallory:evil.example', { evil: { url: 'mxc://evil.example/x' } }),
        pack(MOCHI, { forged: { url: 'mxc://cats.example/f' } }, LUNA),
        { type: 'im.ponies.room_emotes', state_key: 'shared', sender: MOCHI, content: { images: { odd: { url: 'mxc://cats.example/o' } } } },
        pack(LUNA, {
          ok: { url: 'mxc://cats.example/ok' },
          hidden: { url: 'mxc://cats.example/hidden' },
          web: { url: 'https://cats.example/x.png' },
          'bad name': { url: 'mxc://cats.example/b' },
        }),
        { type: 'xyz.nekous.emote_moderation', state_key: '', content: { hidden: ['mxc://cats.example/hidden'] } },
      ],
      SERVER
    );
    assert.deepEqual(
      images.map((image) => image.shortcode),
      ['ok']
    );
  });
});
