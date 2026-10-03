import type { MatrixClient } from 'matrix-js-sdk';
import { adminStore } from './adminStore.js';
import { getServiceClient } from './membership.js';
import { pickPeerRooms, serverOfUser, type DirectoryEntry, type Peer } from './peers.js';
import { FEED_MARKER_EVENT, PROFILE_ROOM_TYPE, readProfileOwner, type RawEvent } from './publicWeb.js';
import { roomOriginServer } from './tenancy.js';

/**
 * The bot's side of peering (docs/federation.md): it joins approved peers' public rooms, so this
 * homeserver takes part in them and every local user (and the public web) can read them the way
 * they read local ones. Matrix has no way to read a room on another server without joining it.
 *
 * What it joins, per peer, under caps:
 *
 * - **Profile rooms** listed in the peer's directory (people's Global posts and pages), and any a
 *   local user follows (`joinFollowedProfile`).
 * - **Public Spaces** listed there, and the feed rooms of the peer's own people in them, so their
 *   posts can reach Everyone. `PEER_SPACE_FEEDS=off` leaves Spaces out.
 *
 * Every room is checked once joined, and left if it isn't what it claimed: a profile room must
 * belong to someone on that peer, a feed room to that member of that Space. It never posts, and
 * it never joins anything on a server that isn't an approved peer. Being in a peer's Space gives
 * nothing in return: tenancy.ts serves voice only in Spaces created on this server.
 */

const SYNC_INTERVAL_MS = 10 * 60_000;
const FIRST_SYNC_DELAY_MS = 30_000;
const DIRECTORY_PAGES = 10;
const MAX_FEEDS_PER_SPACE = 100;
/** Nothing past this many rooms from one peer, whatever asked: directory, follows, Spaces. */
const HARD_MAX_ROOMS_PER_PEER = 1000;
const JOIN_PAUSE_MS = 250;
const FEED_ROOM_MEMBER_KEY = 'xyz.nekous.feed_room';
/** History read back after a join: pages of events, enough for a person's posts. */
const BACKFILL_PAGES = 5;
const BACKFILL_PAGE_SIZE = 100;

const positive = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Math.floor(Number(value)) : fallback);
export const PEER_CAPS = {
  profiles: positive(process.env.PEER_MAX_PROFILES, 200),
  spaces: positive(process.env.PEER_MAX_SPACES, 40),
};
const SPACE_FEEDS = process.env.PEER_SPACE_FEEDS !== 'off';

export type PeerStatus = {
  lastSync?: string;
  lastError?: string;
  profiles: number;
  spaces: number;
  feeds: number;
};

/** How the last sync of each peer went, for `purrlor peers`. In memory: a restart syncs again. */
export const peerStatus = new Map<string, PeerStatus>();

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rooms the bot is in that were created on `server`. */
export function joinedRoomsOf(mx: MatrixClient, server: string): string[] {
  return mx
    .getRooms()
    .filter((room) => room.getMyMembership() === 'join' && roomOriginServer(mx, room.roomId) === server)
    .map((room) => room.roomId);
}

function countByType(mx: MatrixClient, roomIds: string[]) {
  let profiles = 0;
  let spaces = 0;
  for (const roomId of roomIds) {
    const type = mx.getRoom(roomId)?.getType();
    if (type === PROFILE_ROOM_TYPE) profiles += 1;
    else if (type === 'm.space') spaces += 1;
  }
  return { profiles, spaces, feeds: roomIds.length - profiles - spaces };
}

async function readDirectory(mx: MatrixClient, server: string): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  let since: string | undefined;
  for (let page = 0; page < DIRECTORY_PAGES; page += 1) {
    const response = await mx.publicRooms({
      server,
      limit: 50,
      ...(since && { since }),
      filter: { room_types: [PROFILE_ROOM_TYPE as never, 'm.space' as never] },
    });
    entries.push(...(response.chunk as DirectoryEntry[]));
    since = response.next_batch;
    if (!since || response.chunk.length === 0) break;
  }
  return entries;
}

const inFlight = new Map<string, Promise<void>>();

async function join(mx: MatrixClient, roomId: string, server: string): Promise<void> {
  const existing = inFlight.get(roomId);
  if (existing) return existing;
  const attempt = mx
    .joinRoom(roomId, { viaServers: [server] })
    .then(() => undefined)
    .finally(() => inFlight.delete(roomId));
  inFlight.set(roomId, attempt);
  return attempt;
}

/**
 * Reads a just-joined room's history back, so this homeserver fetches it from the peer now. A
 * homeserver that joins a room has only what happens from then on: a read stops where it joined,
 * and only paging past that asks the room's server for what came before (checked with
 * Continuwuity: after this, one page from the newest event has the old posts too). Without it,
 * a peer's posts from before the bot joined would show only to someone scrolling far enough.
 */
async function backfill(mx: MatrixClient, roomId: string): Promise<void> {
  let from: string | undefined;
  for (let page = 0; page < BACKFILL_PAGES; page += 1) {
    const query = new URLSearchParams({ dir: 'b', limit: String(BACKFILL_PAGE_SIZE), ...(from && { from }) });
    const res = await fetch(`${mx.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query}`, {
      headers: { Authorization: `Bearer ${mx.getAccessToken()}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { end?: string; chunk?: unknown[] };
    if (!body.end || body.end === from) return;
    from = body.end;
  }
}

async function leave(mx: MatrixClient, roomId: string, why: string): Promise<void> {
  console.warn(`Peering: left ${roomId}: ${why}`);
  await mx.leave(roomId).catch(() => undefined);
}

async function state(mx: MatrixClient, roomId: string): Promise<RawEvent[]> {
  return (await mx.roomState(roomId)) as unknown as RawEvent[];
}

/**
 * Joins a profile room on `server` and keeps it only if it belongs to someone there (and to
 * `expectedOwner`, when one is given). Returns its owner, or undefined if it was left.
 */
async function joinProfileRoom(mx: MatrixClient, roomId: string, server: string, expectedOwner?: string): Promise<string | undefined> {
  const already = mx.getRoom(roomId)?.getMyMembership() === 'join';
  if (!already) await join(mx, roomId, server);
  const owner = readProfileOwner(await state(mx, roomId));
  if (!owner || serverOfUser(owner) !== server || (expectedOwner && owner !== expectedOwner)) {
    if (!already) await leave(mx, roomId, `not a profile room of someone on ${server}`);
    return undefined;
  }
  if (!already) await backfill(mx, roomId).catch(() => undefined);
  return owner;
}

/** The feed rooms the peer's own people have in a Space, from its member events. */
function spaceFeeds(spaceState: RawEvent[], server: string): { userId: string; roomId: string }[] {
  const feeds: { userId: string; roomId: string }[] = [];
  for (const event of spaceState) {
    if (event.type !== 'm.room.member' || !event.state_key || event.content?.membership !== 'join') continue;
    const roomId = event.content[FEED_ROOM_MEMBER_KEY];
    if (typeof roomId !== 'string' || !roomId || serverOfUser(event.state_key) !== server) continue;
    feeds.push({ userId: event.state_key, roomId });
  }
  return feeds.slice(0, MAX_FEEDS_PER_SPACE);
}

/** A feed room is kept only if it's that member's feed in that Space. */
function isFeedOf(feedState: RawEvent[], userId: string, spaceId: string): boolean {
  const create = feedState.find((event) => event.type === 'm.room.create' && event.state_key === '');
  const creator = (create?.content?.creator as string | undefined) ?? create?.sender;
  const marker = feedState.find((event) => event.type === FEED_MARKER_EVENT && event.state_key === '')?.content;
  return creator === userId && marker?.owner === userId && marker?.spaceId === spaceId;
}

/** One pass over one peer: joins what its directory lists, under the caps. */
export async function syncPeer(mx: MatrixClient, peer: Peer): Promise<PeerStatus> {
  const server = peer.serverName;
  const status: PeerStatus = { profiles: 0, spaces: 0, feeds: 0 };
  try {
    const picked = pickPeerRooms(await readDirectory(mx, server), PEER_CAPS);
    let total = joinedRoomsOf(mx, server).length;
    const room = (roomId: string) => mx.getRoom(roomId)?.getMyMembership() === 'join';

    for (const roomId of picked.profiles) {
      if (!room(roomId) && total >= HARD_MAX_ROOMS_PER_PEER) break;
      try {
        const wasIn = room(roomId);
        if (await joinProfileRoom(mx, roomId, server)) {
          if (!wasIn) {
            total += 1;
            await pause(JOIN_PAUSE_MS);
          }
        }
      } catch (err) {
        console.warn(`Peering: couldn't join profile room ${roomId} on ${server}: ${(err as Error).message}`);
      }
    }

    if (SPACE_FEEDS) {
      for (const spaceId of picked.spaces) {
        try {
          if (!room(spaceId)) {
            if (total >= HARD_MAX_ROOMS_PER_PEER) break;
            await join(mx, spaceId, server);
            total += 1;
          }
          const spaceState = await state(mx, spaceId);
          for (const feed of spaceFeeds(spaceState, server)) {
            if (room(feed.roomId)) continue;
            if (total >= HARD_MAX_ROOMS_PER_PEER) break;
            try {
              await join(mx, feed.roomId, server);
              total += 1;
              if (!isFeedOf(await state(mx, feed.roomId), feed.userId, spaceId)) {
                await leave(mx, feed.roomId, `not ${feed.userId}'s feed in ${spaceId}`);
                total -= 1;
              } else {
                await backfill(mx, feed.roomId).catch(() => undefined);
              }
              await pause(JOIN_PAUSE_MS);
            } catch (err) {
              console.warn(`Peering: couldn't join ${feed.userId}'s feed ${feed.roomId}: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          console.warn(`Peering: couldn't join Space ${spaceId} on ${server}: ${(err as Error).message}`);
        }
      }
    }
    Object.assign(status, countByType(mx, joinedRoomsOf(mx, server)), { lastSync: new Date().toISOString() });
  } catch (err) {
    Object.assign(status, countByType(mx, joinedRoomsOf(mx, server)), { lastError: (err as Error).message });
    console.warn(`Peering: couldn't read ${server}'s directory: ${(err as Error).message}`);
  }
  peerStatus.set(server, status);
  return status;
}

let syncing: Promise<void> | undefined;

/** Every approved peer, one after another. A pass already running is joined, not doubled. */
export function syncAllPeers(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const mx = await getServiceClient();
    for (const peer of await adminStore.peers()) await syncPeer(mx, peer);
  })().finally(() => (syncing = undefined));
  return syncing;
}

/** Leaves every room the bot is in that was created on `server`: what removing a peer does. */
export async function leavePeer(server: string): Promise<number> {
  const mx = await getServiceClient();
  const rooms = joinedRoomsOf(mx, server);
  for (const roomId of rooms) {
    await mx.leave(roomId).catch((err: unknown) => console.warn(`Peering: couldn't leave ${roomId}: ${(err as Error).message}`));
  }
  peerStatus.delete(server);
  return rooms.length;
}

/**
 * A local user followed (or opened) a peer's person whose profile room the bot isn't in yet:
 * joins it now, so it reads like any other. Only for an approved peer, and only a room that turns
 * out to be that person's.
 */
export async function joinFollowedProfile(userId: string, roomId: string): Promise<'joined' | 'not-a-peer' | 'not-theirs' | 'full'> {
  const server = serverOfUser(userId);
  if (!(await adminStore.peers()).some((peer) => peer.serverName === server)) return 'not-a-peer';
  const mx = await getServiceClient();
  if (mx.getRoom(roomId)?.getMyMembership() !== 'join' && joinedRoomsOf(mx, server).length >= HARD_MAX_ROOMS_PER_PEER) return 'full';
  return (await joinProfileRoom(mx, roomId, server, userId)) ? 'joined' : 'not-theirs';
}

/** Starts the regular sync (a first pass shortly after start, then every ten minutes). */
export function startPeering(): void {
  const run = () => void syncAllPeers().catch((err: unknown) => console.error('Peering sync failed', err));
  setTimeout(run, FIRST_SYNC_DELAY_MS);
  setInterval(run, SYNC_INTERVAL_MS);
}
