import { describe, expect, it } from 'vitest';
import type { Room } from 'matrix-js-sdk';
import { emotesFromPackContent, getRoomEmotesAtStateKey, groupEmotesBySource, mergeByShortcode } from './emotes';

describe('emotesFromPackContent', () => {
  it('reads emoticon-usable images out of a raw MSC2545 pack, regardless of where it came from', () => {
    const content = {
      pack: { display_name: 'Test pack' },
      images: {
        cat: { url: 'mxc://x/cat' },
        sticker_only: { url: 'mxc://x/sticker', usage: ['sticker'] },
        no_url: {},
      },
    } as unknown as Parameters<typeof emotesFromPackContent>[0];
    expect(emotesFromPackContent(content)).toEqual([{ shortcode: 'cat', mxcUrl: 'mxc://x/cat' }]);
  });

  it('returns nothing for an empty or missing pack', () => {
    expect(emotesFromPackContent({})).toEqual([]);
  });
});

describe('getRoomEmotesAtStateKey', () => {
  it('reads a pack at an arbitrary state key, not only the default ""', () => {
    const events = new Map([
      ['secondary', { getContent: () => ({ images: { fox: { url: 'mxc://x/fox' } } }) }],
    ]);
    const room = {
      currentState: { getStateEvents: (_type: string, stateKey: string) => events.get(stateKey) },
    } as unknown as Room;
    expect(getRoomEmotesAtStateKey(room, 'secondary')).toEqual([{ shortcode: 'fox', mxcUrl: 'mxc://x/fox' }]);
    expect(getRoomEmotesAtStateKey(room, '')).toEqual([]);
  });
});

describe('mergeByShortcode', () => {
  it('keeps the last list a shortcode appears in', () => {
    const result = mergeByShortcode(
      [{ shortcode: 'cat', mxcUrl: 'mxc://x/global-cat' }],
      [{ shortcode: 'cat', mxcUrl: 'mxc://x/channel-cat' }, { shortcode: 'dog', mxcUrl: 'mxc://x/dog' }]
    );
    expect(result).toEqual([
      { shortcode: 'cat', mxcUrl: 'mxc://x/channel-cat' },
      { shortcode: 'dog', mxcUrl: 'mxc://x/dog' },
    ]);
  });
});

describe('groupEmotesBySource', () => {
  const global = [{ shortcode: 'cat', mxcUrl: 'mxc://x/global-cat' }, { shortcode: 'owl', mxcUrl: 'mxc://x/owl' }];
  const space = [{ shortcode: 'cat', mxcUrl: 'mxc://x/space-cat' }, { shortcode: 'dog', mxcUrl: 'mxc://x/dog' }];
  const channel = [{ shortcode: 'dog', mxcUrl: 'mxc://x/channel-dog' }, { shortcode: 'fox', mxcUrl: 'mxc://x/fox' }];

  it("tags each surviving emote with the most specific scope it came from, channel beating space beating global", () => {
    const result = groupEmotesBySource(global, space, channel);
    expect(result).toEqual([
      { shortcode: 'dog', mxcUrl: 'mxc://x/channel-dog', source: 'channel' },
      { shortcode: 'fox', mxcUrl: 'mxc://x/fox', source: 'channel' },
      { shortcode: 'cat', mxcUrl: 'mxc://x/space-cat', source: 'space' },
      { shortcode: 'owl', mxcUrl: 'mxc://x/owl', source: 'global' },
    ]);
  });

  it('returns nothing for three empty lists', () => {
    expect(groupEmotesBySource([], [], [])).toEqual([]);
  });
});
