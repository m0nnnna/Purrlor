import type { MatrixClient, Room } from 'matrix-js-sdk';
import { getChannelCategories, setChannelCategories } from './channelCategories';
import { reorderSpaceChildren } from './spaceChildren';

/**
 * A Space's channel list as one thing to rearrange: the uncategorized channels at the top, then
 * each category with its channels — what dragging in the channel list changes (ChannelList.tsx's
 * useChannelDrag). Stored in two places: the uncategorized order is each channel's `order` in the
 * Space's `m.space.child` links (spaceChildren.ts), and the categories, their order and their
 * channels are one state event (channelCategories.ts). `saveChannelLayout` writes only what a move
 * changed.
 */
export type ChannelLayout = {
  uncategorized: string[];
  categories: { id: string; channelIds: string[] }[];
};

export type ChannelDropTarget = { categoryId: string | null; index: number };

function without(layout: ChannelLayout, channelId: string): ChannelLayout {
  return {
    uncategorized: layout.uncategorized.filter((id) => id !== channelId),
    categories: layout.categories.map((c) => ({ ...c, channelIds: c.channelIds.filter((id) => id !== channelId) })),
  };
}

/** Where a channel is now: its category (null: uncategorized) and position. */
export function channelPosition(layout: ChannelLayout, channelId: string): ChannelDropTarget | undefined {
  const index = layout.uncategorized.indexOf(channelId);
  if (index >= 0) return { categoryId: null, index };
  for (const category of layout.categories) {
    const at = category.channelIds.indexOf(channelId);
    if (at >= 0) return { categoryId: category.id, index: at };
  }
  return undefined;
}

/**
 * The layout with `channelId` moved to `to`. `to.index` is a position among the target's channels
 * as they were *before* the move, so dropping a channel just below itself is no move at all; it's
 * clamped to the list. An unknown category leaves the layout as it was. Pure.
 */
export function moveChannel(layout: ChannelLayout, channelId: string, to: ChannelDropTarget): ChannelLayout {
  const from = channelPosition(layout, channelId);
  if (!from || (to.categoryId !== null && !layout.categories.some((c) => c.id === to.categoryId))) return layout;
  // Taking the channel out first shifts everything after it in the same list up by one.
  const index = from.categoryId === to.categoryId && from.index < to.index ? to.index - 1 : to.index;
  const next = without(layout, channelId);
  const insert = (list: string[]) => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), channelId, ...list.slice(at)];
  };
  if (to.categoryId === null) return { ...next, uncategorized: insert(next.uncategorized) };
  return { ...next, categories: next.categories.map((c) => (c.id === to.categoryId ? { ...c, channelIds: insert(c.channelIds) } : c)) };
}

/** The layout with a category moved to `index` among the categories as they were before. Pure. */
export function moveCategory(layout: ChannelLayout, categoryId: string, index: number): ChannelLayout {
  const from = layout.categories.findIndex((c) => c.id === categoryId);
  if (from < 0) return layout;
  const rest = layout.categories.filter((c) => c.id !== categoryId);
  const at = Math.max(0, Math.min(from < index ? index - 1 : index, rest.length));
  return { ...layout, categories: [...rest.slice(0, at), layout.categories[from], ...rest.slice(at)] };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export function sameLayout(a: ChannelLayout, b: ChannelLayout): boolean {
  return (
    same(a.uncategorized, b.uncategorized) &&
    a.categories.length === b.categories.length &&
    a.categories.every((c, i) => c.id === b.categories[i].id && same(c.channelIds, b.categories[i].channelIds))
  );
}

/**
 * Writes the difference between `before` and `after`: the categories event if any category or its
 * channels changed, and the uncategorized channels' order if that changed (only the links whose
 * order is different, spaceChildren.ts). Names and anything else on the categories are kept.
 */
export async function saveChannelLayout(mx: MatrixClient, space: Room, before: ChannelLayout, after: ChannelLayout): Promise<void> {
  const categoriesChanged =
    before.categories.length !== after.categories.length ||
    before.categories.some((c, i) => c.id !== after.categories[i].id || !same(c.channelIds, after.categories[i].channelIds));
  if (categoriesChanged) {
    const byId = new Map(getChannelCategories(space).map((c) => [c.id, c]));
    const categories = after.categories.flatMap((c) => {
      const stored = byId.get(c.id);
      return stored ? [{ ...stored, channelIds: c.channelIds }] : [];
    });
    await setChannelCategories(mx, space.roomId, categories);
  }
  if (!same(before.uncategorized, after.uncategorized)) await reorderSpaceChildren(mx, space, after.uncategorized);
}
