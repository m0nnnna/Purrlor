import { describe, expect, it } from 'vitest';
import { groupEmotesBySource, mergeByShortcode } from './emotes';

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
