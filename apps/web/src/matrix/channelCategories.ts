import type { MatrixClient, Room } from 'matrix-js-sdk';

/**
 * Discord-style channel categories — a grouping/collapsing concept Matrix has no native
 * equivalent for (Spaces can nest, but a sub-space is a whole separate room with its own
 * membership/permissions, much heavier than "a labeled divider in the channel list"). Modeled
 * as a single custom state event on the Space holding the full category list, each with its own
 * ordered `channelIds` — same "rewrite the whole thing, it's cheap at this scale" approach
 * `spaceChildren.ts`'s `reorderSpaceChildren` already uses for plain channel ordering. A channel
 * not listed in any category's `channelIds` is "uncategorized" — every channel starts there,
 * matching a fresh Space (no categories configured) looking exactly like it did before this
 * existed. Within a category, position in `channelIds` is the display order; existing per-child
 * `m.space.child` `order` (spaceChildren.ts) still governs the uncategorized bucket, unchanged.
 */
export const CHANNEL_CATEGORIES_EVENT_TYPE = 'xyz.nekous.channel_categories';

export type ChannelCategory = {
  id: string;
  name: string;
  channelIds: string[];
};

export function getChannelCategories(space: Room): ChannelCategory[] {
  const content = space.currentState.getStateEvents(CHANNEL_CATEGORIES_EVENT_TYPE, '')?.getContent() as
    | { categories?: ChannelCategory[] }
    | undefined;
  return content?.categories ?? [];
}

export async function setChannelCategories(mx: MatrixClient, spaceId: string, categories: ChannelCategory[]): Promise<void> {
  await mx.sendStateEvent(spaceId, CHANNEL_CATEGORIES_EVENT_TYPE as any, { categories } as any, '');
}

function newCategoryId(): string {
  return `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createCategory(mx: MatrixClient, space: Room, name: string): Promise<void> {
  const categories = getChannelCategories(space);
  await setChannelCategories(mx, space.roomId, [...categories, { id: newCategoryId(), name, channelIds: [] }]);
}

export async function renameCategory(mx: MatrixClient, space: Room, categoryId: string, name: string): Promise<void> {
  const categories = getChannelCategories(space).map((c) => (c.id === categoryId ? { ...c, name } : c));
  await setChannelCategories(mx, space.roomId, categories);
}

/** Channels that were in this category simply fall back to "uncategorized" — no cleanup needed
 *  elsewhere, since membership is derived from being listed, not a back-reference. */
export async function deleteCategory(mx: MatrixClient, space: Room, categoryId: string): Promise<void> {
  const categories = getChannelCategories(space).filter((c) => c.id !== categoryId);
  await setChannelCategories(mx, space.roomId, categories);
}

export async function reorderCategories(mx: MatrixClient, space: Room, orderedCategoryIds: string[]): Promise<void> {
  const byId = new Map(getChannelCategories(space).map((c) => [c.id, c]));
  const reordered = orderedCategoryIds.map((id) => byId.get(id)).filter((c): c is ChannelCategory => !!c);
  await setChannelCategories(mx, space.roomId, reordered);
}

/** Moves a channel into `categoryId` (or uncategorizes it if `null`), pulling it out of whatever
 *  category it was previously in first — a channel belongs to at most one category at a time,
 *  matching Discord's own model. Appends to the end of the target category's order. */
export async function moveChannelToCategory(
  mx: MatrixClient,
  space: Room,
  channelId: string,
  categoryId: string | null
): Promise<void> {
  const categories = getChannelCategories(space).map((c) => ({
    ...c,
    channelIds: c.channelIds.filter((id) => id !== channelId),
  }));
  if (categoryId) {
    const target = categories.find((c) => c.id === categoryId);
    if (target) target.channelIds.push(channelId);
  }
  await setChannelCategories(mx, space.roomId, categories);
}

export async function reorderCategoryChannels(
  mx: MatrixClient,
  space: Room,
  categoryId: string,
  orderedChannelIds: string[]
): Promise<void> {
  const categories = getChannelCategories(space).map((c) =>
    c.id === categoryId ? { ...c, channelIds: orderedChannelIds } : c
  );
  await setChannelCategories(mx, space.roomId, categories);
}
