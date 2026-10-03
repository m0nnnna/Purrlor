import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { moveCategory, moveChannel, sameLayout, type ChannelDropTarget, type ChannelLayout } from '../../matrix/channelLayout';

/**
 * Dragging channels and categories in the channel list, the way Discord does: a channel to another
 * place in its category, to another category, or to the uncategorized channels at the top; a
 * category to another place among the categories. Pointer events, so mouse, pen and touch all work:
 * a mouse drag starts once the pointer has moved a few pixels (a click is still a click), a touch
 * drag after holding still for a moment (a swipe still scrolls). Escape cancels. A line shows where
 * the drop lands, and the list scrolls when the pointer nears its top or bottom.
 *
 * The list marks what can be dragged and where things can land with data attributes:
 * - a channel row: `data-nu-drag-channel="<roomId>"`, `data-nu-drag-category="<categoryId or ''>"`,
 *   `data-nu-drag-index`
 * - a category's header: `data-nu-drag-header="<categoryId>"`, `data-nu-drag-count` (its channels),
 * - a category's whole block (header and channels): `data-nu-drag-block="<categoryId>"`,
 *   `data-nu-drag-index`
 *
 * How a drop changes the layout is matrix/channelLayout.ts (pure, tested); this only works out where
 * the pointer is.
 */

export type DragItem = { kind: 'channel'; id: string; label: string } | { kind: 'category'; id: string; label: string };

/** A mouse must move this far before it's a drag rather than a click. */
const MOUSE_SLOP = 5;
/** A finger must hold this long without moving this far before it's a drag rather than a scroll. */
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 8;
/** Within this many pixels of the list's top or bottom, it scrolls. */
const EDGE = 40;

type Anchor =
  | { kind: 'row'; el: HTMLElement; categoryId: string | null; index: number }
  | { kind: 'header'; el: HTMLElement; categoryId: string; count: number };

const categoryOf = (el: HTMLElement) => (el.dataset.nuDragCategory ? el.dataset.nuDragCategory : null);

/** Where a channel dragged to `y` lands, and where to draw the line. Exported for tests. */
export function channelTarget(anchors: Anchor[], y: number, uncategorizedCount: number): { target: ChannelDropTarget; lineY: number } {
  const endOf = (anchor: Anchor | undefined): { target: ChannelDropTarget; lineY: number } => {
    if (!anchor) return { target: { categoryId: null, index: uncategorizedCount }, lineY: NaN };
    const rect = anchor.el.getBoundingClientRect();
    return anchor.kind === 'row'
      ? { target: { categoryId: anchor.categoryId, index: anchor.index + 1 }, lineY: rect.bottom }
      : { target: { categoryId: anchor.categoryId, index: anchor.count }, lineY: rect.bottom };
  };
  for (const [i, anchor] of anchors.entries()) {
    const rect = anchor.el.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      if (anchor.kind === 'row') return { target: { categoryId: anchor.categoryId, index: anchor.index }, lineY: rect.top };
      // Above a header's middle: the end of whatever comes before it.
      const before = endOf(anchors[i - 1]);
      return Number.isNaN(before.lineY) ? { ...before, lineY: rect.top } : before;
    }
  }
  return endOf(anchors[anchors.length - 1]);
}

export function useChannelDrag({
  containerRef,
  enabled,
  layout,
  onDrop,
}: {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  layout: ChannelLayout;
  onDrop: (next: ChannelLayout) => void;
}) {
  const [dragging, setDragging] = useState<DragItem | null>(null);
  /** Where the drop line is, in the container's scrolled coordinates; null when there's nowhere to drop. */
  const [lineTop, setLineTop] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const cleanupRef = useRef<(() => void) | null>(null);
  const justDraggedRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(), []);

  const start = useCallback(
    (item: DragItem, event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || cleanupRef.current) return;
      // The row's own buttons (its menus) keep working as buttons.
      if ((event.target as HTMLElement).closest('[data-nu-drag-ignore]')) return;
      const container = containerRef.current;
      if (!container) return;
      const touch = event.pointerType !== 'mouse';
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let lastY = startY;
      let target: ChannelDropTarget | number | null = null;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      let scrollFrame = 0;

      const anchors = (): Anchor[] => {
        const found: Anchor[] = [];
        container.querySelectorAll<HTMLElement>('[data-nu-drag-channel], [data-nu-drag-header]').forEach((el) => {
          if (el.dataset.nuDragChannel !== undefined) {
            if (el.dataset.nuDragChannel === item.id) return;
            found.push({ kind: 'row', el, categoryId: categoryOf(el), index: Number(el.dataset.nuDragIndex) });
          } else {
            found.push({ kind: 'header', el, categoryId: el.dataset.nuDragHeader ?? '', count: Number(el.dataset.nuDragCount) });
          }
        });
        return found;
      };

      const toContainer = (clientY: number) => {
        const rect = container.getBoundingClientRect();
        return clientY - rect.top + container.scrollTop;
      };

      const track = (clientY: number) => {
        if (item.kind === 'channel') {
          const found = channelTarget(anchors(), clientY, layoutRef.current.uncategorized.length);
          target = found.target;
          setLineTop(Number.isNaN(found.lineY) ? null : toContainer(found.lineY));
        } else {
          const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-nu-drag-block]')).filter((el) => el.dataset.nuDragBlock !== item.id);
          const next = blocks.find((el) => {
            const rect = el.getBoundingClientRect();
            return clientY < rect.top + rect.height / 2;
          });
          if (next) {
            target = Number(next.dataset.nuDragIndex);
            setLineTop(toContainer(next.getBoundingClientRect().top));
          } else {
            target = layoutRef.current.categories.length;
            const last = blocks[blocks.length - 1];
            setLineTop(last ? toContainer(last.getBoundingClientRect().bottom) : null);
          }
        }
      };

      // Near the edges, keep scrolling (and re-aiming) while the pointer stays there.
      const autoScroll = () => {
        const rect = container.getBoundingClientRect();
        const speed = lastY < rect.top + EDGE ? -8 : lastY > rect.bottom - EDGE ? 8 : 0;
        if (speed) {
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

      const finish = (drop: boolean) => {
        cleanupRef.current?.();
        if (!active) return;
        justDraggedRef.current = true;
        // The click that ends a mouse drag lands on whatever's under it: not a channel to open.
        setTimeout(() => (justDraggedRef.current = false), 0);
        if (!drop || target === null) return;
        const current = layoutRef.current;
        const next =
          item.kind === 'channel'
            ? moveChannel(current, item.id, target as ChannelDropTarget)
            : moveCategory(current, item.id, target as number);
        if (!sameLayout(current, next)) onDropRef.current(next);
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

  /** For a row's or header's own onClick: false right after a drag ended on it. */
  const clickAllowed = useCallback(() => !justDraggedRef.current, []);

  return { dragging, lineTop, pointer, start, clickAllowed };
}
