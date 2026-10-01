import { describe, expect, it } from 'vitest';
import { sharedPostText } from './useShareTarget';

const share = (fields: Record<string, string>) => sharedPostText(new URLSearchParams(fields));

describe('sharedPostText', () => {
  it('puts the title, text and link on their own lines', () => {
    expect(share({ share_title: 'Cats', share_text: 'look at this', share_url: 'https://example.org/cats' })).toBe(
      'Cats\nlook at this\nhttps://example.org/cats'
    );
  });

  it("doesn't repeat a link the text already carries", () => {
    expect(share({ share_text: 'look https://example.org/cats', share_url: 'https://example.org/cats' })).toBe(
      'look https://example.org/cats'
    );
  });

  it("doesn't repeat a title the text starts with", () => {
    expect(share({ share_title: 'Cats', share_text: 'Cats are great' })).toBe('Cats are great');
  });

  it('is undefined when nothing was shared', () => {
    expect(share({})).toBeUndefined();
    expect(share({ share_text: '   ' })).toBeUndefined();
  });
});
