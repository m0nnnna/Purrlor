import { describe, expect, it } from 'vitest';
import { emptyProfilePage, LIMITS, parseProfilePage, type ProfilePage } from '../../matrix/profilePage';
import {
  addBlock,
  canAddBlock,
  findEmote,
  imageCount,
  moveBlock,
  readabilityProblems,
  removeBlock,
  STARTER_PAGES,
  withFormattedText,
} from './editorModel';

const withBlocks = (...types: Parameters<typeof addBlock>[1][]) => types.reduce((page, type) => addBlock(page, type), emptyProfilePage());

describe('editorModel', () => {
  it('adds blocks at the end with fresh IDs', () => {
    const page = withBlocks('text', 'links', 'divider');
    expect(page.blocks.map((block) => block.type)).toEqual(['text', 'links', 'divider']);
    expect(new Set(page.blocks.map((block) => block.id)).size).toBe(3);
  });

  it('moves a block up and down, and not past either end', () => {
    const page = withBlocks('text', 'image', 'divider');
    const [a, b, c] = page.blocks.map((block) => block.id);
    expect(moveBlock(page, c, -1).blocks.map((block) => block.id)).toEqual([a, c, b]);
    expect(moveBlock(page, a, -1)).toBe(page);
    expect(moveBlock(page, c, 1)).toBe(page);
    expect(removeBlock(page, b).blocks.map((block) => block.id)).toEqual([a, c]);
  });

  it('stops offering blocks at the limit', () => {
    let page = emptyProfilePage();
    for (let i = 0; i < LIMITS.blocks; i++) page = addBlock(page, 'divider');
    expect(canAddBlock(page)).toBe(false);
  });

  it('counts images, the background included, but not gallery pieces (they load when their album opens)', () => {
    const page: ProfilePage = {
      ...emptyProfilePage(),
      style: { ...emptyProfilePage().style, background: { kind: 'image', url: 'mxc://s/bg', fit: 'cover' } },
      blocks: [
        { id: 'a', type: 'image', url: 'mxc://s/a' },
        { id: 'b', type: 'image', url: '' },
        { id: 'c', type: 'gallery', ratings: false, albums: [{ id: 'x', title: 'X', pieces: [{ url: 'mxc://s/1', tags: [], rating: 'general' }] }] },
      ],
    };
    expect(imageCount(page)).toBe(2);
  });

  it('works out text formatting from the author’s emotes', () => {
    const page: ProfilePage = { ...emptyProfilePage(), blocks: [{ id: 't', type: 'text', body: 'hi :cat:' }] };
    const formatted = withFormattedText(page, [{ shortcode: 'cat', mxcUrl: 'mxc://s/cat' }]);
    const block = formatted.blocks[0];
    expect(block.type === 'text' && block.formatted).toContain('mxc://s/cat');
    // …and drops a stale one when the text has nothing to format any more.
    const plain = withFormattedText({ ...page, blocks: [{ id: 't', type: 'text', body: 'hi', formatted: 'old' }] }, []);
    expect(plain.blocks[0]).toEqual({ id: 't', type: 'text', body: 'hi' });
  });

  it('flags text that is hard to read', () => {
    const style = emptyProfilePage().style;
    expect(readabilityProblems(style)).toEqual([]);
    expect(readabilityProblems({ ...style, colors: { ...style.colors, text: '#111111' } })).toEqual(['background', 'blocks']);
    // A see-through block isn't judged as if it were solid.
    expect(readabilityProblems({ ...style, blockOpacity: 0.4, colors: { ...style.colors, block: '#f4effa' } })).toEqual([]);
  });

  it('finds an emote by shortcode, with or without colons', () => {
    const emotes = [{ shortcode: 'cat', mxcUrl: 'mxc://s/cat' }];
    expect(findEmote(emotes, ':cat:')?.mxcUrl).toBe('mxc://s/cat');
    expect(findEmote(emotes, 'cat')?.mxcUrl).toBe('mxc://s/cat');
    expect(findEmote(emotes, 'dog')).toBeUndefined();
    expect(findEmote(emotes, '')).toBeUndefined();
  });

  it('has starter looks the parser keeps exactly as they are', () => {
    for (const starter of STARTER_PAGES) {
      expect(parseProfilePage({ version: 1, style: starter.style, blocks: [] })?.style).toEqual(starter.style);
    }
  });
});
