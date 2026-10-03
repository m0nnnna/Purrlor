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
 * The public Spaces in the local homeserver's room directory, or with `server`, an approved
 * federated instance's (docs/federation.md; Discover offers only those, never arbitrary servers),
 * for Discover. Only
 * Spaces: a public Space's channels are listed in the directory too, but they're found inside the
 * Space once you've joined it, not one by one. The directory is asked for Spaces (`room_types`),
 * and the page is filtered here as well in case a server ignores that.
 */
export async function browsePublicSpaces(
  mx: MatrixClient,
  { searchTerm, since, server }: { searchTerm?: string; since?: string; server?: string } = {}
): Promise<PublicRoomsPage> {
  const trimmed = searchTerm?.trim();
  const page = await mx.publicRooms({
    ...(server && { server }),
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
 *  joinRoom accepts either) and hands back the joined room's actual ID, for navigating there.
 *  `server`: the instance whose directory listed it, to join through. */
export async function joinPublicRoom(mx: MatrixClient, roomIdOrAlias: string, server?: string): Promise<string> {
  const room = server ? await mx.joinRoom(roomIdOrAlias, { viaServers: [server] }) : await mx.joinRoom(roomIdOrAlias);
  return room.roomId;
}
