import { describe, expect, it } from 'vitest';
import { LIMITS, parseProfilePage, type PageBlock } from './profilePage';

const MXC = 'mxc://purr.example.org/abcDEF123';
// What these blocks hold; which column each sits in is profilePage.test.ts's ("block sides").
const page = (extra: Record<string, unknown>) => {
  const parsed = parseProfilePage({ version: 1, ...extra });
  return parsed && { ...parsed, blocks: parsed.blocks.map(({ side: _side, ...block }) => block as PageBlock) };
};
type Of<T extends PageBlock['type']> = Extract<PageBlock, { type: T }>;

describe('the social blocks', () => {
  it('keeps a Top 8 of real Matrix IDs, once each, at most eight', () => {
    const users = Array.from({ length: 12 }, (_, i) => `@friend${i}:purr.example`);
    const block = page({
      blocks: [{ id: 'f', type: 'friends', users: ['@luna:purr.example', '@luna:purr.example', 'luna', '@x"><script>:evil', 5, null, ...users] }],
    })?.blocks[0] as Of<'friends'>;
    expect(block.type).toBe('friends');
    expect(block.users).toHaveLength(LIMITS.friends);
    expect(block.users[0]).toBe('@luna:purr.example');
    expect(new Set(block.users).size).toBe(block.users.length);
    expect(block.users.every((user) => /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-:[\]]+$/.test(user))).toBe(true);
  });

  it('drops a Top 8 with nobody valid in it', () => {
    expect(page({ blocks: [{ id: 'f', type: 'friends', users: ['nobody', '<b>x</b>'] }] })?.blocks).toEqual([]);
  });

  it('reads a guestbook with its rules clamped and its word list cleaned', () => {
    const block = page({
      blocks: [{ id: 'g', type: 'guestbook', who: 'everyone-on-earth', slowmode: 999999, blockedWords: ['  rude  ', 'rude', '', 7, 'a'.repeat(100)] }],
    })?.blocks[0];
    expect(block).toEqual({
      id: 'g',
      type: 'guestbook',
      who: 'everyone',
      slowmode: LIMITS.guestbookSlowmode,
      blockedWords: ['rude', 'a'.repeat(LIMITS.guestbookWord)],
    });
    expect(page({ blocks: [{ id: 'g', type: 'guestbook', who: 'following', slowmode: -4 }] })?.blocks[0]).toMatchObject({
      who: 'following',
      slowmode: 0,
      blockedWords: [],
    });
  });
});

describe('the gallery block', () => {
  it('reads the older art block as a gallery with ratings on, keeping albums of rated pieces with cleaned tags', () => {
    const block = page({
      blocks: [
        {
          id: 'a',
          type: 'art',
          albums: [
            {
              id: 'one',
              title: 'Sketches',
              description: 'wip',
              pieces: [
                { url: MXC, title: 'Cat', description: 'a cat', tags: ['#Cats', 'cats', 'ink', '', 3], rating: 'mature' },
                { url: 'https://evil.example/x.png' },
                { url: MXC, rating: 'extreme' },
              ],
            },
            { id: 'empty', title: 'Nothing', pieces: [] },
            { title: '', pieces: [{ url: MXC }] },
          ],
        },
      ],
    })?.blocks[0] as Of<'gallery'>;
    expect(block.type).toBe('gallery');
    expect(block.ratings).toBe(true);
    expect(block.albums).toHaveLength(1);
    expect(block.albums[0].pieces).toEqual([
      { url: MXC, title: 'Cat', description: 'a cat', tags: ['cats', 'ink'], rating: 'mature' },
      { url: MXC, tags: [], rating: 'general' },
    ]);
  });

  it('caps gallery pieces across a page', () => {
    const album = (id: string, count: number) => ({ id, title: id, pieces: Array.from({ length: count }, () => ({ url: MXC })) });
    const blocks = page({
      blocks: [
        { id: 'a', type: 'art', albums: [album('x', LIMITS.albumPieces), album('y', LIMITS.albumPieces)] },
        { id: 'b', type: 'art', albums: [album('z', LIMITS.albumPieces)] },
        { id: 'c', type: 'art', albums: [album('w', 5)] },
      ],
    })?.blocks as Of<'gallery'>[];
    const total = blocks.reduce((sum, block) => sum + block.albums.reduce((n, a) => n + a.pieces.length, 0), 0);
    expect(total).toBe(LIMITS.galleryPieces);
    expect(blocks.map((block) => block.id)).toEqual(['a', 'b']);
  });

  it('gives albums with the same ID their own', () => {
    const block = page({
      blocks: [
        {
          id: 'a',
          type: 'art',
          albums: [
            { id: 'same', title: 'One', pieces: [{ url: MXC }] },
            { id: 'same', title: 'Two', pieces: [{ url: MXC }] },
          ],
        },
      ],
    })?.blocks[0] as Of<'gallery'>;
    expect(new Set(block.albums.map((album) => album.id)).size).toBe(2);
  });

  it('keeps ratings only when the gallery asks for them', () => {
    const albums = [{ id: 'x', title: 'X', pieces: [{ url: MXC, rating: 'mature', tags: ['ink'] }] }];
    const rated = page({ blocks: [{ id: 'g', type: 'gallery', ratings: true, albums }] })?.blocks[0] as Of<'gallery'>;
    expect(rated.ratings).toBe(true);
    expect(rated.albums[0].pieces[0].rating).toBe('mature');
    const plain = page({ blocks: [{ id: 'g', type: 'gallery', albums }] })?.blocks[0] as Of<'gallery'>;
    expect(plain.ratings).toBe(false);
    expect(plain.albums[0].pieces[0]).toEqual({ url: MXC, tags: ['ink'], rating: 'general' });
    const stringy = page({ blocks: [{ id: 'g', type: 'gallery', ratings: 'yes', albums }] })?.blocks[0] as Of<'gallery'>;
    expect(stringy.ratings).toBe(false);
  });

  it('reads an older gallery of flat images as one album, captions becoming descriptions', () => {
    const block = page({
      blocks: [{ id: 'g', type: 'gallery', title: 'Holiday', images: [{ url: MXC, caption: 'beach' }, { url: 'https://evil.example/x.png' }, { url: MXC }] }],
    })?.blocks[0] as Of<'gallery'>;
    expect(block.ratings).toBe(false);
    expect(block.albums).toEqual([
      {
        id: 'a0',
        title: 'Holiday',
        pieces: [
          { url: MXC, description: 'beach', tags: [], rating: 'general' },
          { url: MXC, tags: [], rating: 'general' },
        ],
      },
    ]);
  });

  it('keeps a commissions block, which carries only a title', () => {
    expect(page({ blocks: [{ id: 'c', type: 'commissions', title: 'Commissions', price: 5, html: '<b>' }] })?.blocks).toEqual([
      { id: 'c', type: 'commissions', title: 'Commissions' },
    ]);
  });
});
