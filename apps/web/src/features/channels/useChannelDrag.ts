import type { RefObject } from 'react';
import { locateInList, usePointerDrag, type DropGuess } from '../../components/usePointerDrag';
import { moveCategory, moveChannel, sameLayout, type ChannelDropTarget, type ChannelLayout } from '../../matrix/channelLayout';

/**
 * Dragging channels and categories in the channel list, the way Discord does: a channel to another
 * place in its category, to another category, or to the uncategorized channels at the top; a
 * category to another place among the categories. The pointer handling (mouse, pen, touch, the drop
 * line, scrolling at the edges) is components/usePointerDrag.ts; this works out where a drop lands.
 *
 * The list marks what can be dragged and where things can land with data attributes:
 * - a channel row: `data-nu-drag-channel="<roomId>"`, `data-nu-drag-category="<categoryId or ''>"`,
 *   `data-nu-drag-index`
 * - a category's header: `data-nu-drag-header="<categoryId>"`, `data-nu-drag-count` (its channels),
 * - a category's whole block (header and channels): `data-nu-drag-block="<categoryId>"`
 *
 * How a drop changes the layout is matrix/channelLayout.ts (pure, tested).
 */

export type DragItem = { kind: 'channel'; id: string; label: string } | { kind: 'category'; id: string; label: string };

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

function anchorsIn(container: HTMLElement, draggedId: string): Anchor[] {
  const found: Anchor[] = [];
  container.querySelectorAll<HTMLElement>('[data-nu-drag-channel], [data-nu-drag-header]').forEach((el) => {
    if (el.dataset.nuDragChannel !== undefined) {
      if (el.dataset.nuDragChannel === draggedId) return;
      found.push({ kind: 'row', el, categoryId: categoryOf(el), index: Number(el.dataset.nuDragIndex) });
    } else {
      found.push({ kind: 'header', el, categoryId: el.dataset.nuDragHeader ?? '', count: Number(el.dataset.nuDragCount) });
    }
  });
  return found;
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
  return usePointerDrag<DragItem, ChannelDropTarget | number>({
    containerRef,
    enabled,
    locate: (item, clientY, container): DropGuess<ChannelDropTarget | number> => {
      if (item.kind === 'category') return locateInList(container, 'data-nu-drag-block', item.id, clientY);
      const found = channelTarget(anchorsIn(container, item.id), clientY, layout.uncategorized.length);
      return { target: found.target, lineY: Number.isNaN(found.lineY) ? null : found.lineY };
    },
    drop: (item, target) => {
      const next =
        item.kind === 'channel' ? moveChannel(layout, item.id, target as ChannelDropTarget) : moveCategory(layout, item.id, target as number);
      if (!sameLayout(layout, next)) onDrop(next);
    },
  });
}
