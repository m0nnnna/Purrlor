import { describe, expect, it } from 'vitest';
import { findBlockedWord, normalizeForMatching } from './automod';

describe('findBlockedWord', () => {
  it('matches whole words, ignoring case and punctuation', () => {
    expect(findBlockedWord('Well, CAT!', ['cat'])).toBe('cat');
    expect(findBlockedWord('concatenate', ['cat'])).toBeUndefined();
  });

  it('ignores accents on either side', () => {
    expect(findBlockedWord('what a crème', ['creme'])).toBe('creme');
    expect(findBlockedWord('what a creme', ['crème'])).toBe('crème');
  });

  it('matches phrases across any punctuation or spacing', () => {
    expect(findBlockedWord('buy   cheap-pills now', ['cheap pills'])).toBe('cheap pills');
    expect(findBlockedWord('cheap and pills', ['cheap pills'])).toBeUndefined();
  });

  it('ignores blank entries and works with nothing blocked', () => {
    expect(findBlockedWord('anything', ['', '   ', '!!!'])).toBeUndefined();
    expect(findBlockedWord('anything', [])).toBeUndefined();
  });

  it('reads punctuation in an entry as a space, never as a pattern', () => {
    // "a.*" is the word "a": it doesn't match "abc" the way a regular expression would.
    expect(findBlockedWord('abc', ['a.*'])).toBeUndefined();
    expect(findBlockedWord('a.b', ['a.*'])).toBe('a.*');
    expect(normalizeForMatching('(a+)+$')).toBe(' a ');
  });
});
