import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * Dragging something to a new place in a vertical list, with the mouse, a pen or a finger: the
 * pointer handling the channel list (features/channels/useChannelDrag.ts) and the server rail
 * (features/servers/useSpaceDrag.ts) share. Each says where a drop at a given height would land
 * (`locate`) and what dropping does (`drop`); this does the rest:
 *
 * - a mouse drag starts once the pointer has moved a few pixels, so a click is still a click;
 * - a touch drag starts after holding still for a moment, so a swipe still scrolls;
 * - the list scrolls while the pointer is near its top or bottom, and Escape cancels;
 * - `lineTop` says where to draw the drop line, in the list's scrolled coordinates, and `pointer`
 *   where to draw a label that follows it.
 *
 * Elements inside an item marked `data-nu-drag-ignore` (its menus, say) never start a drag.
 */

export type DragItemBase = { id: string; label: string };
/** Where a drop at some height lands, and the height (client coordinates) to draw the line at. */
export type DropGuess<T> = { target: T; lineY: number | null } | null;

/** A mouse must move this far before it's a drag rather than a click. */
const MOUSE_SLOP = 5;
/** A finger must hold this long without moving this far before it's a drag rather than a scroll. */
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 8;
/** Within this many pixels of the list's top or bottom, it scrolls. */
const EDGE = 40;

export function usePointerDrag<I extends DragItemBase, T>({
  containerRef,
  enabled,
  locate,
  drop,
}: {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  locate: (item: I, clientY: number, container: HTMLElement) => DropGuess<T>;
  drop: (item: I, target: T) => void;
}) {
  const [dragging, setDragging] = useState<I | null>(null);
  const [lineTop, setLineTop] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const cleanupRef = useRef<(() => void) | null>(null);
  const justDraggedRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(), []);

  const start = useCallback(
    (item: I, event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || cleanupRef.current) return;
      if ((event.target as HTMLElement).closest('[data-nu-drag-ignore]')) return;
      const container = containerRef.current;
      if (!container) return;
      const touch = event.pointerType !== 'mouse';
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let lastY = startY;
      let guess: DropGuess<T> = null;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      let scrollFrame = 0;

      const track = (clientY: number) => {
        guess = locateRef.current(item, clientY, container);
        const rect = container.getBoundingClientRect();
        setLineTop(guess && guess.lineY !== null ? guess.lineY - rect.top + container.scrollTop : null);
      };

      // Near the edges, keep scrolling (and re-aiming) while the pointer stays there.
      const autoScroll = () => {
        const rect = container.getBoundingClientRect();
        const speed = lastY < rect.top + EDGE ? -8 : lastY > rect.bottom - EDGE ? 8 : 0;
        if (speed && container.scrollHeight > container.clientHeight) {
          container.scrollTop += speed;
          track(lastY);
        }
        scrollFrame = requestAnimationFrame(autoScroll);
      };

      const activate = () => {
        active = true;
        setDragging(item);
        track(lastY);
        scrollFrame = requestAnimationFrame(autoScroll);
      };

      const finish = (dropIt: boolean) => {
        cleanupRef.current?.();
        if (!active) return;
        justDraggedRef.current = true;
        // The click that ends a mouse drag lands on whatever's under it: not something to open.
        setTimeout(() => (justDraggedRef.current = false), 0);
        if (dropIt && guess) dropRef.current(item, guess.target);
      };

      const onMove = (e: PointerEvent) => {
        lastY = e.clientY;
        const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (!active) {
          if (touch) {
            // Moving before the hold is up: a scroll, not a drag.
            if (moved > TOUCH_SLOP) finish(false);
            return;
          }
          if (moved < MOUSE_SLOP) return;
          activate();
        }
        setPointer({ x: e.clientX, y: e.clientY });
        track(e.clientY);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish(false);
      };
      // Once a touch drag has started, the page mustn't scroll under the finger instead.
      const onTouchMove = (e: TouchEvent) => {
        if (active) e.preventDefault();
      };

      cleanupRef.current = () => {
        clearTimeout(holdTimer);
        cancelAnimationFrame(scrollFrame);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('touchmove', onTouchMove);
        cleanupRef.current = null;
        setDragging(null);
        setLineTop(null);
        setPointer(null);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      if (touch) {
        holdTimer = setTimeout(() => {
          setPointer({ x: startX, y: startY });
          activate();
        }, TOUCH_HOLD_MS);
      }
    },
    [containerRef, enabled]
  );

  /** For an item's own onClick: false right after a drag ended on it. */
  const clickAllowed = useCallback(() => !justDraggedRef.current, []);

  return { dragging, lineTop, pointer, start, clickAllowed };
}

/**
 * Where a drop lands in a flat list of items, each marked with `attribute` (its ID) in the order
 * shown: before the first item whose middle is below the pointer, else after the last. The index
 * counts the items as they were before the move, the dragged one included.
 */
export function locateInList(container: HTMLElement, attribute: string, draggedId: string, clientY: number): DropGuess<number> {
  const all = Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`));
  const others = all.filter((el) => el.getAttribute(attribute) !== draggedId);
  for (const el of others) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return { target: all.indexOf(el), lineY: rect.top };
  }
  const last = others[others.length - 1];
  return { target: all.length, lineY: last ? last.getBoundingClientRect().bottom : null };
}
