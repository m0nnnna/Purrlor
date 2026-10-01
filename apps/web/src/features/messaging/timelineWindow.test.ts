import { describe, expect, it } from 'vitest';
import { INITIAL_RENDER_WINDOW, sliceRenderWindow, windowReaching } from './timelineWindow';

describe('sliceRenderWindow', () => {
  it('draws only the newest messages of a long history, and says how many are held back', () => {
    const history = Array.from({ length: 5000 }, (_, i) => i);
    const { shown, hiddenOlder } = sliceRenderWindow(history, INITIAL_RENDER_WINDOW);
    expect(shown).toHaveLength(50);
    expect(shown[0]).toBe(4950);
    expect(shown[49]).toBe(4999);
    expect(hiddenOlder).toBe(4950);
  });

  it('draws everything when there is less than a window of it', () => {
    const few = [1, 2, 3];
    expect(sliceRenderWindow(few, 50)).toEqual({ shown: few, hiddenOlder: 0 });
    expect(sliceRenderWindow([], 50)).toEqual({ shown: [], hiddenOlder: 0 });
  });

  it('reveals older messages as the window grows', () => {
    const history = Array.from({ length: 120 }, (_, i) => i);
    expect(sliceRenderWindow(history, 50).hiddenOlder).toBe(70);
    expect(sliceRenderWindow(history, 80).hiddenOlder).toBe(40);
    expect(sliceRenderWindow(history, 200).hiddenOlder).toBe(0);
  });
});

describe('windowReaching', () => {
  it('is wide enough to draw a message that is older than the window', () => {
    const history = Array.from({ length: 300 }, (_, i) => i);
    const target = 200;
    const { shown } = sliceRenderWindow(history, windowReaching(history.length, target, 30));
    expect(shown).toContain(target);
    expect(shown[0]).toBe(target - 30);
  });
});
