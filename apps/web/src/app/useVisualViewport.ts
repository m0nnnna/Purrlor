import { useEffect } from 'react';

/**
 * Sizes the app to the part of the screen actually showing (`--nu-viewport-height`), and keeps the
 * page itself from scrolling (styles/base/shell.css). On an iPhone the keyboard doesn't make the
 * page smaller: it covers the bottom and scrolls the whole page up to show the field, so the
 * header slid off the top, the composer floated, and taps landed on the wrong things until the
 * page was scrolled back. Following the visual viewport, the app shrinks to sit above the
 * keyboard instead, the way a native app does.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--nu-viewport-height', `${Math.round(viewport.height)}px`);
        // The keyboard is up: the home bar's safe area is under it, so no gap is kept for it.
        root.toggleAttribute('data-nu-keyboard', window.innerHeight - viewport.height > 120);
        // iOS scrolls the (locked) page to bring a focused field into view: put it back.
        if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
      });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--nu-viewport-height');
      root.removeAttribute('data-nu-keyboard');
    };
  }, []);
}
