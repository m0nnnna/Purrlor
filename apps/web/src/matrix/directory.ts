import { RoomType, type IPublicRoomsChunkRoom, type MatrixClient } from 'matrix-js-sdk';

const PAGE_SIZE = 30;

// matrix-js-sdk declares this shape (as the resolved type of mx.publicRooms()) but doesn't
// export it — IPublicRoomsChunkRoom is exported, the response wrapper around it isn't.
export type PublicRoomsPage = {
  chunk: IPublicRoomsChunkRoom[];
  next_batch?: string;
  prev_batch?: string;
  total_room_count_estimate?: number;
};

/**
 * The public Spaces in the local homeserver's room directory (no `server` option — scoped to this
 * account's own server, not cross-federation search, matching the narrower reach every other
 * "find something" flow in this app uses, e.g. AddExistingChannelModal), for Discover. Only
 * Spaces: a public Space's channels are listed in the directory too, but they're found inside the
 * Space once you've joined it, not one by one. The directory is asked for Spaces (`room_types`),
 * and the page is filtered here as well in case a server ignores that.
 */
export async function browsePublicSpaces(
  mx: MatrixClient,
  { searchTerm, since }: { searchTerm?: string; since?: string } = {}
): Promise<PublicRoomsPage> {
  const trimmed = searchTerm?.trim();
  const page = await mx.publicRooms({
    limit: PAGE_SIZE,
    since,
    filter: { room_types: [RoomType.Space], ...(trimmed && { generic_search_term: trimmed }) },
  });
  return { ...page, chunk: page.chunk.filter(isSpaceEntry) };
}

export function isSpaceEntry(entry: IPublicRoomsChunkRoom): boolean {
  return entry.room_type === RoomType.Space;
}

/** Joins a public directory entry by room ID (aliases resolve the same way — matrix-js-sdk's
 *  joinRoom accepts either) and hands back the joined room's actual ID, for navigating there. */
export async function joinPublicRoom(mx: MatrixClient, roomIdOrAlias: string): Promise<string> {
  const room = await mx.joinRoom(roomIdOrAlias);
  return room.roomId;
}
