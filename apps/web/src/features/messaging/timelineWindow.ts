/** How many messages a room view draws when it opens: the latest ones, however many the session has
 *  loaded (the live timeline keeps every page scrolled back so far, and a long-lived room can hold
 *  thousands). Scrolling up first reveals more of what's loaded, then fetches older pages. */
export const INITIAL_RENDER_WINDOW = 50;

/** On a phone (the one-pane layout, styles/base/shell.css), fewer: a screen shows a dozen at most,
 *  and drawing 50 when a channel opened was most of the wait. */
export const INITIAL_RENDER_WINDOW_NARROW = 30;

export function initialRenderWindow(): number {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches ? INITIAL_RENDER_WINDOW_NARROW : INITIAL_RENDER_WINDOW;
}

/** The newest `windowSize` of `items`, and how many older ones are loaded but not drawn. */
export function sliceRenderWindow<T>(items: T[], windowSize: number): { shown: T[]; hiddenOlder: number } {
  const hiddenOlder = Math.max(0, items.length - Math.max(0, windowSize));
  return { shown: hiddenOlder > 0 ? items.slice(hiddenOlder) : items, hiddenOlder };
}

/** The window that draws back to `targetIndex` (an index into `total` loaded messages), with some room past it. */
export function windowReaching(total: number, targetIndex: number, margin: number): number {
  return total - targetIndex + margin;
}
