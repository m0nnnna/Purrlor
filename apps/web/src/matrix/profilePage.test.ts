import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  DEFAULT_PAGE_STYLE,
  LIMITS,
  newBlockId,
  parseProfilePage,
  readableTextOn,
  readHttpsUrl,
  readLine,
  readMxc,
  readPageStyle,
  type PageBlock,
} from './profilePage';

const MXC = 'mxc://purr.example.org/abcDEF123';
const page = (extra: Record<string, unknown>) => parseProfilePage({ version: 1, ...extra });

describe('parseProfilePage', () => {
  it('is undefined for no page: empty content, no version, or not an object', () => {
    expect(parseProfilePage({})).toBeUndefined();
    expect(parseProfilePage({ blocks: [] })).toBeUndefined();
    expect(parseProfilePage(null)).toBeUndefined();
    expect(parseProfilePage('page')).toBeUndefined();
    expect(parseProfilePage([{ version: 1 }])).toBeUndefined();
    expect(parseProfilePage({ version: 0 })).toBeUndefined();
  });

  it('gives an empty page the default style', () => {
    expect(page({})).toEqual({ version: 1, style: DEFAULT_PAGE_STYLE, blocks: [] });
  });

  it('reads a page a future version wrote as far as it understands it', () => {
    expect(page({ version: 7, blocks: [{ id: 'a', type: 'text', body: 'hi' }] })?.blocks).toEqual([{ id: 'a', type: 'text', body: 'hi' }]);
  });

  it('keeps every kind of block the builder makes', () => {
    const blocks = [
      { id: 't', type: 'text', title: 'About', body: 'hello :cat:', formatted: 'hello <img data-mx-emoticon src="mxc://a/b">' },
      { id: 'l', type: 'links', items: [{ label: 'Art', url: 'https://example.art/', emote: MXC, color: '#ff00aa' }] },
      { id: 'i', type: 'image', url: MXC, caption: 'me', link: 'https://example.org/' },
      {
        id: 'g',
        type: 'gallery',
        ratings: false,
        albums: [{ id: 'a1', title: 'Photos', pieces: [{ url: MXC, tags: [], rating: 'general' }, { url: MXC, description: 'two', tags: ['x'], rating: 'general' }] }],
      },
      { id: 's', type: 'song', url: 'https://youtu.be/dQw4w9WgXcQ' },
      {
        id: 'p',
        type: 'spaces',
        spaces: [{ roomId: '!abc:purr.example.org', name: 'Cat Cafe', avatarUrl: MXC, via: ['purr.example.org'] }],
      },
      { id: 'd', type: 'divider', style: 'emote', emote: MXC },
    ];
    expect(page({ blocks })?.blocks).toEqual(blocks);
  });

  it('drops blocks it does not know, and fields it does not know', () => {
    const result = page({
      blocks: [
        { id: 'a', type: 'html', html: '<script>alert(1)</script>' },
        { id: 'b', type: 'css', css: 'body { display: none }' },
        { id: 'c', type: 'text', body: 'hi', style: 'position: fixed', onclick: 'x()' },
        'not a block',
        null,
      ],
      css: '* { color: red }',
    });
    expect(result?.blocks).toEqual([{ id: 'c', type: 'text', body: 'hi' }]);
    expect(result).not.toHaveProperty('css');
  });

  it('only keeps links that are https, with no password in them', () => {
    const items = [
      { label: 'js', url: 'javascript:alert(1)' },
      { label: 'data', url: 'data:text/html,<script>alert(1)</script>' },
      { label: 'plain', url: 'http://example.org' },
      { label: 'creds', url: 'https://user:pass@example.org' },
      { label: 'relative', url: '/settings' },
      { label: 'ok', url: 'https://example.org/path?q=1' },
      { label: '', url: 'https://example.org/no-label' },
    ];
    const block = page({ blocks: [{ id: 'l', type: 'links', items }] })?.blocks[0];
    expect(block).toEqual({ id: 'l', type: 'links', items: [{ label: 'ok', url: 'https://example.org/path?q=1' }] });
  });

  it('only keeps images that are mxc:// URLs', () => {
    const hostile = [
      'https://evil.example/track.png',
      'mxc://server/id") ; background: url(https://evil.example/x',
      'mxc://server/../../etc',
      'mxc://server/',
      'javascript:alert(1)',
    ];
    for (const url of hostile) {
      expect(page({ blocks: [{ id: 'i', type: 'image', url }] })?.blocks).toEqual([]);
      expect(page({ style: { background: { kind: 'image', url } } })?.style.background).toEqual({ kind: 'color' });
    }
  });

  it('drops a link button emote or block link that is not allowed, keeping the rest', () => {
    const result = page({
      blocks: [
        {
          id: 'l',
          type: 'links',
          items: [{ label: 'Art', url: 'https://example.art', emote: 'https://evil.example/e.png', color: 'red' }],
        },
        { id: 'i', type: 'image', url: MXC, link: 'javascript:alert(1)' },
      ],
    });
    expect(result?.blocks).toEqual([
      { id: 'l', type: 'links', items: [{ label: 'Art', url: 'https://example.art/' }] },
      { id: 'i', type: 'image', url: MXC },
    ]);
  });

  it('keeps labels and titles to one line of their own length', () => {
    const result = page({
      blocks: [
        { id: 'l', type: 'links', title: 'x'.repeat(500), items: [{ label: 'a\nb\u0000c' + 'y'.repeat(100), url: 'https://e.org' }] },
      ],
    });
    const block = result?.blocks[0] as Extract<PageBlock, { type: 'links' }>;
    expect(block.title).toHaveLength(LIMITS.title);
    expect(block.items[0].label.startsWith('a b c')).toBe(true);
    expect(block.items[0].label).toHaveLength(LIMITS.label);
  });

  it('caps the number of blocks, links, gallery images and spaces', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, type: 'text', body: `${i}` }));
    expect(page({ blocks: many })?.blocks).toHaveLength(LIMITS.blocks);

    const links = Array.from({ length: 50 }, (_, i) => ({ label: `${i}`, url: 'https://e.org' }));
    const linksBlock = page({ blocks: [{ id: 'l', type: 'links', items: links }] })?.blocks[0];
    expect(linksBlock?.type === 'links' && linksBlock.items).toHaveLength(LIMITS.links);

    // An older gallery (a flat list of images) becomes one album, cut to the album limit.
    const images = Array.from({ length: 50 }, () => ({ url: MXC }));
    const gallery = page({ blocks: [{ id: 'g', type: 'gallery', images }] })?.blocks[0];
    expect(gallery?.type === 'gallery' && gallery.albums).toHaveLength(1);
    expect(gallery?.type === 'gallery' && gallery.albums[0].pieces).toHaveLength(LIMITS.albumPieces);
  });

  it('stops adding image blocks once the page has 20, counting the background; galleries load lazily and are not counted', () => {
    const image = (id: string) => ({ id, type: 'image', url: MXC });
    const result = page({
      style: { background: { kind: 'image', url: MXC } },
      blocks: [
        ...Array.from({ length: 19 }, (_, i) => image(`i${i}`)),
        { id: 'g', type: 'gallery', images: [{ url: MXC }] },
        image('over'),
        { id: 't', type: 'text', body: 'still here' },
      ],
    });
    const kinds = result?.blocks.map((block) => block.type);
    // 1 background + 19 = 20; the gallery still fits, the next image block goes, the text stays.
    expect(kinds).toEqual([...Array(19).fill('image'), 'gallery', 'text']);
  });

  it('gives blocks unique, safe IDs', () => {
    const result = page({
      blocks: [
        { id: 'same', type: 'text', body: '1' },
        { id: 'same', type: 'text', body: '2' },
        { id: '"><img src=x>', type: 'text', body: '3' },
        { type: 'text', body: '4' },
      ],
    });
    const ids = result?.blocks.map((block) => block.id) ?? [];
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,17}$/);
  });

  it('drops empty blocks', () => {
    expect(
      page({
        blocks: [
          { id: 'a', type: 'text', body: '   ' },
          { id: 'b', type: 'links', items: [] },
          { id: 'c', type: 'gallery', images: [] },
          { id: 'c2', type: 'gallery', albums: [{ id: 'x', title: 'Empty', pieces: [] }] },
          { id: 'd', type: 'spaces', spaces: [{ roomId: 'not a room', name: 'x' }] },
          { id: 'e', type: 'song', url: 'ftp://example.org/song.mp3' },
        ],
      })?.blocks
    ).toEqual([]);
  });

  it('keeps Spaces with room version 12 IDs, which have no server part', () => {
    const spaces = [{ roomId: '!1LCLCSdyDTw4k9B7LgwtRfuRnYkXsdeE1eMz9Ik8tbE', name: 'Cat Cafe' }];
    expect(page({ blocks: [{ id: 's', type: 'spaces', spaces }] })?.blocks).toEqual([{ id: 's', type: 'spaces', spaces }]);
    expect(page({ blocks: [{ id: 's', type: 'spaces', spaces: [{ roomId: '!abc def', name: 'x' }, { roomId: '#alias:s', name: 'x' }] }] })?.blocks).toEqual([]);
  });

  it('turns an emote divider with no emote into a line', () => {
    expect(page({ blocks: [{ id: 'd', type: 'divider', style: 'emote' }] })?.blocks).toEqual([{ id: 'd', type: 'divider', style: 'line' }]);
  });
});

describe('music blocks', () => {
  const track = (extra: Record<string, unknown> = {}) => ({ url: MXC, mimetype: 'audio/mpeg', title: 'Moonlight', ...extra });
  const music = (tracks: unknown, extra: Record<string, unknown> = {}) => page({ blocks: [{ id: 'm', type: 'music', tracks, ...extra }] })?.blocks;

  it('keeps a track list as the builder writes it', () => {
    const tracks = [track({ artist: 'Luna', duration: 201, size: 4_800_000 }), track({ mimetype: 'audio/ogg', title: 'B-side' })];
    expect(music(tracks, { title: 'My songs' })).toEqual([{ id: 'm', type: 'music', title: 'My songs', tracks }]);
  });

  it('only keeps mxc:// files', () => {
    for (const url of ['https://example.org/song.mp3', 'http://purr.example.org/a', 'javascript:alert(1)', 'data:audio/mpeg;base64,AAAA', 'mxc://purr.example.org/../../etc', 'mxc://a/b c']) {
      expect(music([track({ url })])).toEqual([]);
    }
  });

  it('only keeps audio types browsers play, normalised', () => {
    for (const mimetype of ['text/html', 'image/svg+xml', 'application/javascript', 'video/mp4', 'audio/x-shockwave', 'audio/*', '', 42, undefined]) {
      expect(music([track({ mimetype })])).toEqual([]);
    }
    const kept = music([track({ mimetype: 'Audio/OGG; codecs=opus' })]);
    expect(kept?.[0].type === 'music' && kept[0].tracks[0].mimetype).toBe('audio/ogg');
  });

  it('keeps title and artist to one line each, and needs a title', () => {
    expect(music([track({ title: '   ' })])).toEqual([]);
    const result = music([track({ title: 'line one\nline two\u0000<b>', artist: `${'x'.repeat(300)}\r\n` })]);
    const kept = result?.[0].type === 'music' ? result[0].tracks[0] : undefined;
    expect(kept?.title).toBe('line one line two <b>');
    expect(kept?.artist).toHaveLength(LIMITS.trackTitle);
  });

  it('drops a duration or size that is not a sensible number, keeping the track', () => {
    for (const extra of [{ duration: -1 }, { duration: Infinity }, { duration: LIMITS.trackDuration + 1 }, { duration: '200' }, { size: 1.5 }, { size: -10 }, { size: 2 ** 60 }]) {
      const result = music([track(extra)]);
      expect(result?.[0].type === 'music' && result[0].tracks[0]).toEqual(track());
    }
  });

  it('drops fields it does not know', () => {
    const result = music([track({ onplay: 'x()', autoplay: true, src: 'https://evil.example/' })], { autoplay: true, style: 'position: fixed' });
    expect(result).toEqual([{ id: 'm', type: 'music', tracks: [track()] }]);
  });

  it('caps tracks across the whole page, and drops a music block with none left', () => {
    const many = Array.from({ length: 50 }, (_, i) => track({ title: `${i}` }));
    const result = page({
      blocks: [
        { id: 'a', type: 'music', tracks: many.slice(0, 15) },
        { id: 'b', type: 'music', tracks: many.slice(15, 30) },
        { id: 'c', type: 'music', tracks: many.slice(30) },
        { id: 't', type: 'text', body: 'still here' },
      ],
    })?.blocks;
    expect(result?.map((block) => (block.type === 'music' ? block.tracks.length : block.type))).toEqual([15, 5, 'text']);
  });

  it('does not count tracks toward the 20 images', () => {
    const image = (id: string) => ({ id, type: 'image', url: MXC });
    const images = Array.from({ length: 20 }, (_, i) => image(`i${i}`));
    const result = page({ blocks: [{ id: 'm', type: 'music', tracks: [track()] }, ...images] })?.blocks;
    expect(result).toHaveLength(21);
  });

  it('drops a music block with no usable tracks', () => {
    expect(music([])).toEqual([]);
    expect(music('tracks')).toEqual([]);
    expect(music([null, 'x', { title: 'no file' }])).toEqual([]);
  });
});

describe('readPageStyle', () => {
  it('falls back to the default for anything that is not one of the choices', () => {
    expect(
      readPageStyle({
        colors: { bg: 'red', text: '#fff', accent: 'url(x)', link: '#12345g', block: 'var(--evil)' },
        fonts: { heading: 'Comic Sans", serif; } body { color: red', body: 42 },
        corners: '12px',
        border: 'groove',
        borderColor: 'expression(alert(1))',
        blockOpacity: 'solid',
        columns: 3,
        effect: 'fireworks',
      })
    ).toEqual(DEFAULT_PAGE_STYLE);
  });

  it('accepts colours in either case and stores them lower-case', () => {
    expect(readPageStyle({ colors: { bg: '#AABBCC' } }).colors.bg).toBe('#aabbcc');
  });

  it('clamps numbers to their range', () => {
    const wild = readPageStyle({
      corners: 9999,
      blockOpacity: -5,
      background: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 720 },
    });
    expect(wild.corners).toBe(LIMITS.corners);
    expect(wild.blockOpacity).toBe(LIMITS.minBlockOpacity);
    expect(wild.background).toEqual({ kind: 'gradient', from: '#000000', to: '#ffffff', angle: 359 });
    expect(readPageStyle({ corners: Number.NaN, blockOpacity: Infinity }).corners).toBe(DEFAULT_PAGE_STYLE.corners);
  });

  it('needs both colours for a gradient', () => {
    expect(readPageStyle({ background: { kind: 'gradient', from: '#000000' } }).background).toEqual({ kind: 'color' });
  });
});

describe('single values', () => {
  it('readMxc', () => {
    expect(readMxc(MXC)).toBe(MXC);
    expect(readMxc('mxc://[::1]:8448/abc')).toBe('mxc://[::1]:8448/abc');
    expect(readMxc('mxc://server/a b')).toBeUndefined();
    expect(readMxc(42)).toBeUndefined();
  });

  it('readHttpsUrl normalises and refuses everything else', () => {
    expect(readHttpsUrl(' https://Example.org ')).toBe('https://example.org/');
    expect(readHttpsUrl('https://' + 'a'.repeat(600) + '.org')).toBeUndefined();
    expect(readHttpsUrl('HTTPS://example.org/x')).toBe('https://example.org/x');
  });

  it('readLine', () => {
    expect(readLine('  hi  ', 10)).toBe('hi');
    expect(readLine('\n\t', 10)).toBeUndefined();
    expect(readLine('🐱🐱🐱', 2)).toBe('🐱🐱');
  });
});

describe('contrast', () => {
  it('measures black on white as 21 and a colour on itself as 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('suggests dark text on light backgrounds and light text on dark ones', () => {
    expect(readableTextOn('#fafafa')).toBe('#111111');
    expect(readableTextOn('#0d0a13')).toBe('#ffffff');
  });
});

describe('newBlockId', () => {
  it('makes an ID the page does not have yet', () => {
    const blocks: PageBlock[] = [{ id: 'b1', type: 'divider', style: 'line' }];
    const id = newBlockId(blocks);
    expect(id).toMatch(/^b[a-z0-9]{1,8}$/);
    expect(id).not.toBe('b1');
  });
});
