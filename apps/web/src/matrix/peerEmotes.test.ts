import { describe, expect, it } from 'vitest';
import { parsePeerEmotes, peerShortcode } from './peerEmotes';

describe('peerShortcode', () => {
  it("adds the peer's server name, in characters a shortcode allows", () => {
    expect(peerShortcode('wave', 'cats.example')).toBe('wave+cats-example');
    expect(peerShortcode('wave', 'chat.cats.example:8448')).toBe('wave+chat-cats-example-8448');
  });
});

describe('parsePeerEmotes', () => {
  it("reads each peer's emotes and stickers, renamed, and leaves out anything out of shape", () => {
    const parsed = parsePeerEmotes({
      peers: [
        {
          serverName: 'cats.example',
          name: 'Cat Server',
          images: [
            { shortcode: 'wave', url: 'mxc://cats.example/w', body: 'wave', emoticon: true, sticker: false },
            { shortcode: 'stamp', url: 'mxc://cats.example/s', body: 'A stamp', emoticon: false, sticker: true },
            { shortcode: 'web', url: 'https://cats.example/x.png', emoticon: true },
            { shortcode: 'bad name', url: 'mxc://cats.example/b', emoticon: true },
          ],
        },
        { serverName: 'empty.example', name: 'Empty', images: [] },
        { name: 'No server', images: [] },
      ],
    });
    expect(parsed).toEqual([
      {
        serverName: 'cats.example',
        name: 'Cat Server',
        emotes: [{ shortcode: 'wave+cats-example', mxcUrl: 'mxc://cats.example/w' }],
        stickers: [{ shortcode: 'stamp+cats-example', mxcUrl: 'mxc://cats.example/s', body: 'A stamp' }],
      },
    ]);
  });

  it('reads nothing from an answer that isn’t one', () => {
    expect(parsePeerEmotes(null)).toEqual([]);
    expect(parsePeerEmotes({ peers: 'x' })).toEqual([]);
  });
});
