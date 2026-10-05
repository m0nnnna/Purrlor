import { describe, expect, it } from 'vitest';
import { EMBEDS_KEY, embeddableLinks, hasEmbedsField, playerFrameUrl, readEmbeds } from './embeds';

describe('embeddableLinks', () => {
  it('finds the first three http(s) links, in order, once each', () => {
    expect(embeddableLinks('a https://one.example/x b http://two.example c https://one.example/x d https://three.example e https://four.example')).toEqual([
      'https://one.example/x',
      'http://two.example',
      'https://three.example',
    ]);
  });

  it('leaves the sentence’s punctuation off, but keeps a link’s own parentheses', () => {
    expect(embeddableLinks('see https://example.com/page.')).toEqual(['https://example.com/page']);
    expect(embeddableLinks('(https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(embeddableLinks('https://en.wikipedia.org/wiki/Cat_(disambiguation)!')).toEqual(['https://en.wikipedia.org/wiki/Cat_(disambiguation)']);
  });

  it('skips links written <like this>, and links in code', () => {
    expect(embeddableLinks('no embed <https://quiet.example> please')).toEqual([]);
    expect(embeddableLinks('`https://code.example` and ```\nhttps://block.example\n``` but https://yes.example')).toEqual(['https://yes.example']);
  });

  it('ignores other schemes', () => {
    expect(embeddableLinks('ftp://files.example javascript:alert(1) mailto:a@b.example')).toEqual([]);
  });
});

describe('playerFrameUrl', () => {
  it('builds each provider’s frame from a valid ID only', () => {
    expect(playerFrameUrl({ provider: 'youtube', id: 'dQw4w9WgXcQ' }, 'purr.example')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
    expect(playerFrameUrl({ provider: 'twitch-video', id: '123' }, 'purr.example')).toBe('https://player.twitch.tv/?video=123&parent=purr.example&autoplay=true');
    expect(playerFrameUrl({ provider: 'youtube', id: 'x" onload="alert(1)' }, 'purr.example')).toBeUndefined();
    expect(playerFrameUrl({ provider: 'spotify', id: 'track/../../evil' }, 'purr.example')).toBeUndefined();
    expect(playerFrameUrl({ provider: 'evil', id: 'x' }, 'purr.example')).toBeUndefined();
    expect(playerFrameUrl({ provider: 'constructor', id: 'x' }, 'purr.example')).toBeUndefined();
  });
});

describe('readEmbeds', () => {
  const image = { url: 'mxc://purr.example/thumb', info: { mimetype: 'image/jpeg', w: 480, h: 360, size: 1000 } };
  const content = (embeds: unknown, body = 'look https://a.example and https://b.example and https://c.example') => ({ body, [EMBEDS_KEY]: embeds });

  it('keeps well-formed embeds for links the body has', () => {
    const embeds = readEmbeds(content([{ url: 'https://a.example', kind: 'card', title: 'A', site: { name: 'Site', color: '#AABBCC' }, image }]));
    expect(embeds).toEqual([{ url: 'https://a.example', kind: 'card', title: 'A', site: { name: 'Site', color: '#AABBCC' }, image }]);
  });

  it('drops what doesn’t belong: other links, unknown kinds, scripts, foreign pictures', () => {
    const embeds = readEmbeds(
      content([
        { url: 'https://elsewhere.example', kind: 'card', title: 'not in the body' },
        { url: 'https://a.example', kind: 'html', title: 'unknown kind' },
        { url: 'javascript:alert(1)', kind: 'card', title: 'x' },
        {
          url: 'https://b.example',
          kind: 'card',
          title: 'B',
          site: { color: 'red; background:url(x)' },
          image: { url: 'https://tracker.example/pixel.gif', info: { mimetype: 'image/gif' } },
          author: { name: 'Eve', url: 'javascript:alert(1)' },
        },
      ])
    );
    expect(embeds).toEqual([{ url: 'https://b.example', kind: 'card', title: 'B', author: { name: 'Eve' } }]);
  });

  it('makes a player with a bad ID a card, and drops a file kind without its file', () => {
    const embeds = readEmbeds(
      content([
        { url: 'https://a.example', kind: 'player', title: 'P', player: { provider: 'youtube', id: '<script>' } },
        { url: 'https://b.example', kind: 'image' },
        { url: 'https://c.example', kind: 'video', media: { url: 'mxc://purr.example/v', info: { mimetype: 'image/png' } } },
      ])
    );
    expect(embeds).toEqual([{ url: 'https://a.example', kind: 'card', title: 'P' }]);
  });

  it('keeps an encrypted picture, and cuts long text', () => {
    const file = { url: 'mxc://purr.example/enc', key: { k: 'x' }, iv: 'iv', hashes: { sha256: 'h' }, v: 'v2' };
    const [embed] = readEmbeds(content([{ url: 'https://a.example', kind: 'post', description: 'x'.repeat(5000), image: { file, info: { mimetype: 'image/png' } } }]));
    expect(embed.description).toHaveLength(1000);
    expect(embed.image).toEqual({ file, info: { mimetype: 'image/png' } });
  });

  it('keeps at most three', () => {
    const body = 'https://a.example https://b.example https://c.example https://d.example';
    const many = ['a', 'b', 'c', 'd'].map((x) => ({ url: `https://${x}.example`, kind: 'card', title: x }));
    expect(readEmbeds({ body, [EMBEDS_KEY]: many })).toHaveLength(3);
  });

  it('tells an event that says "no embeds" from one that says nothing', () => {
    expect(hasEmbedsField({ body: 'x', [EMBEDS_KEY]: [] })).toBe(true);
    expect(hasEmbedsField({ body: 'x' })).toBe(false);
  });
});
