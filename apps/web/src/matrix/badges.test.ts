import { describe, expect, it } from 'vitest';
import { badgeTextColor, parseBadges } from './badges';

describe('badges', () => {
  it('keeps only well-formed 4-letter coloured badges', () => {
    const map = parseBadges({ badges: { '@a:x': [{ id: 'a', text: 'STAR', color: '#aa66ff' }, { id: 'b', text: 'LONGER', color: '#aa66ff' }, { id: 'c', text: 'ABCD', color: 'red' }], nope: [] } });
    expect(map).toEqual({ '@a:x': [{ id: 'a', text: 'STAR', color: '#aa66ff' }] });
  });
  it('picks a readable text colour', () => {
    expect(badgeTextColor('#ffffff')).toBe('#111');
    expect(badgeTextColor('#220044')).toBe('#fff');
  });
});
