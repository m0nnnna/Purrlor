import { describe, expect, it } from 'vitest';
import { panelPosition } from './ReactionPicker';

const view = { width: 1280, height: 800 };
const panel = { width: 220, height: 110 };

describe('panelPosition', () => {
  it('opens under the 😀, lined up with its left edge', () => {
    expect(panelPosition({ left: 400, top: 300, bottom: 324 }, panel, view)).toEqual({ left: 400, top: 328 });
  });

  it('opens over the 😀 when there is no room under it', () => {
    expect(panelPosition({ left: 400, top: 700, bottom: 724 }, panel, view)).toEqual({ left: 400, top: 586 });
  });

  it('stays inside the window at its right edge', () => {
    expect(panelPosition({ left: 1200, top: 300, bottom: 324 }, panel, view).left).toBe(1280 - 220 - 8);
  });

  it('a panel taller than either side still fits the window', () => {
    const tall = { width: 330, height: 700 };
    const { top } = panelPosition({ left: 400, top: 380, bottom: 404 }, tall, view);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + tall.height).toBeLessThanOrEqual(800 - 8);
  });
});
