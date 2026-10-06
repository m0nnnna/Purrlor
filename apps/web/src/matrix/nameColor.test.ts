import { describe, expect, it } from 'vitest';
import { NAME_COLOR_PRESETS, sanitizeNameColor } from './nameColor';

describe('sanitizeNameColor', () => {
  it('keeps a #rrggbb color, lowercased', () => {
    expect(sanitizeNameColor('#FF8FAB')).toBe('#ff8fab');
    expect(sanitizeNameColor(' #a5b4fc ')).toBe('#a5b4fc');
  });

  it('drops anything that isn’t one', () => {
    expect(sanitizeNameColor('red')).toBe('');
    expect(sanitizeNameColor('#fff')).toBe('');
    expect(sanitizeNameColor('#ff8fab; background: url(x)')).toBe('');
    expect(sanitizeNameColor(42)).toBe('');
    expect(sanitizeNameColor(undefined)).toBe('');
  });

  it('accepts every preset', () => {
    for (const color of NAME_COLOR_PRESETS) expect(sanitizeNameColor(color)).toBe(color);
  });
});
