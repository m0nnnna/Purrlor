import type { MatrixClient } from 'matrix-js-sdk';
import { serverOfUser, type Peer } from './peers.js';
import type { RawEvent } from './publicWeb.js';
import { roomOriginServer } from './tenancy.js';

/**
 * Peers' global emote libraries (docs/federation.md, "Emotes and stickers"): the bot joins each
 * approved peer's library room, the same way it joins their public rooms, and the app asks for
 * what's in them (`POST /api/public/peers/emotes`), so this server's people can use a peer's emotes
 * and stickers. Using one needs nothing more: a message carries its emote's image, which every
 * homeserver can fetch.
 *
 * A peer's library is read by the same rules the app reads this server's with
 * (apps/web/src/matrix/emoteLibrary.ts): one pack per person, under their own user ID, and only
 * that server's own people; the peer's moderators' hidden images left out; one image per shortcode,
 * the earliest added.
 */

export const EMOTE_LIBRARY_ROOM_TYPE = 'xyz.nekous.emote_library';
const PACK_EVENT = 'im.ponies.room_emotes';
const MODERATION_EVENT = 'xyz.nekous.emote_moderation';
const ADDED_AT_KEY = 'xyz.nekous.added_at';
const MXC = /^mxc:\/\/[^/\s]+\/[^/\s?#]+$/;
/** Generous for one server's library (50 images a person), and a cap on what one peer can send us. */
const MAX_IMAGES_PER_PEER = 2000;

export function emoteLibraryAlias(server: string): string {
  return `#purrlor-emotes:${server}`;
}

export type LibraryImage = { shortcode: string; url: string; body: string; emoticon: boolean; sticker: boolean };

type PackImage = { url?: unknown; usage?: unknown; body?: unknown; [ADDED_AT_KEY]?: unknown };

/** Whether `state` is `server`'s library: its type, and the alias that server vouches for. */
export function isLibraryOf(state: RawEvent[], server: string): boolean {
  const create = state.find((event) => event.type === 'm.room.create' && event.state_key === '');
  const alias = state.find((event) => event.type === 'm.room.canonical_alias' && event.state_key === '');
  return create?.content?.type === EMOTE_LIBRARY_ROOM_TYPE && alias?.content?.alias === emoteLibraryAlias(server);
}

/** The images everyone on `server` sees in its library, from the room's state. Pure. */
export function libraryImages(state: RawEvent[], server: string): LibraryImage[] {
  const moderation = state.find((event) => event.type === MODERATION_EVENT && event.state_key === '');
  const hiddenList = moderation?.content?.hidden;
  const hidden = new Set(Array.isArray(hiddenList) ? hiddenList.filter((url): url is string => typeof url === 'string') : []);
  const winners = new Map<string, LibraryImage & { addedAt: number; owner: string }>();
  for (const event of state) {
    const owner = event.state_key;
    // Someone's own pack, by someone on that server: a person from elsewhere who joined the room
    // could write one under their own ID, and it doesn't count.
    if (event.type !== PACK_EVENT || !owner?.startsWith('@') || owner !== event.sender || serverOfUser(owner) !== server) continue;
    const images = (event.content?.images ?? {}) as Record<string, PackImage>;
    for (const [shortcode, image] of Object.entries(images)) {
      if (!/^[a-zA-Z0-9_+-]{1,100}$/.test(shortcode) || typeof image?.url !== 'string' || !MXC.test(image.url) || hidden.has(image.url)) continue;
      const usage = Array.isArray(image.usage) ? image.usage : undefined;
      const addedAt = typeof image[ADDED_AT_KEY] === 'number' ? image[ADDED_AT_KEY] : (event.origin_server_ts ?? 0);
      const candidate = {
        shortcode,
        url: image.url,
        body: typeof image.body === 'string' && image.body ? image.body.slice(0, 200) : shortcode,
        // No usage at all: an emote, as the app reads it.
        emoticon: !usage || usage.includes('emoticon'),
        sticker: !!usage?.includes('sticker'),
        addedAt,
        owner,
      };
      const current = winners.get(shortcode);
      if (!current || addedAt < current.addedAt || (addedAt === current.addedAt && owner < current.owner)) winners.set(shortcode, candidate);
    }
  }
  return [...winners.values()]
    .sort((a, b) => a.shortcode.localeCompare(b.shortcode))
    .slice(0, MAX_IMAGES_PER_PEER)
    .map(({ shortcode, url, body, emoticon, sticker }) => ({ shortcode, url, body, emoticon, sticker }));
}

async function roomState(mx: MatrixClient, roomId: string): Promise<RawEvent[]> {
  return (await mx.roomState(roomId)) as unknown as RawEvent[];
}

/** The peer's library room the bot is in, if it is in one. */
function joinedLibraryOf(mx: MatrixClient, server: string): string | undefined {
  return mx
    .getRooms()
    .find(
      (room) =>
        room.getMyMembership() === 'join' &&
        room.getType() === EMOTE_LIBRARY_ROOM_TYPE &&
        roomOriginServer(mx, room.roomId) === server &&
        room.getCanonicalAlias() === emoteLibraryAlias(server)
    )?.roomId;
}

/**
 * Joins `server`'s library, when it has one, and keeps it only if it is that: the library's type,
 * that server's alias, and created there. Part of each peer's sync (peering.ts). Returns whether
 * the bot is in it.
 */
export async function joinPeerLibrary(mx: MatrixClient, server: string): Promise<boolean> {
  if (joinedLibraryOf(mx, server)) return true;
  let roomId: string;
  try {
    roomId = (await mx.getRoomIdForAlias(emoteLibraryAlias(server))).room_id;
  } catch {
    return false; // That server hasn't set one up (or isn't answering): nothing to join.
  }
  await mx.joinRoom(roomId, { viaServers: [server] });
  const state = await roomState(mx, roomId);
  const create = state.find((event) => event.type === 'm.room.create' && event.state_key === '');
  if (!isLibraryOf(state, server) || (create?.sender && serverOfUser(create.sender) !== server)) {
    console.warn(`Peering: left ${roomId}: not ${server}'s emote library`);
    await mx.leave(roomId).catch(() => undefined);
    return false;
  }
  return true;
}

export type PeerEmotes = { serverName: string; name: string; images: LibraryImage[] };

/** What's in every peer's library the bot is in, read fresh at most once a minute. */
let cache: { at: number; peers: PeerEmotes[] } | undefined;
const CACHE_MS = 60_000;

export async function readPeerEmotes(mx: MatrixClient, peers: Peer[]): Promise<PeerEmotes[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.peers;
  const result: PeerEmotes[] = [];
  for (const peer of peers) {
    const roomId = joinedLibraryOf(mx, peer.serverName);
    if (!roomId) continue;
    try {
      const state = await roomState(mx, roomId);
      if (!isLibraryOf(state, peer.serverName)) continue;
      const images = libraryImages(state, peer.serverName);
      if (images.length) result.push({ serverName: peer.serverName, name: peer.name || peer.serverName, images });
    } catch (err) {
      console.warn(`Peering: couldn't read ${peer.serverName}'s emote library: ${(err as Error).message}`);
    }
  }
  cache = { at: Date.now(), peers: result };
  return result;
}

/** Test seam, and for after a peer is removed. */
export function forgetPeerEmotes(): void {
  cache = undefined;
}
