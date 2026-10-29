import type { MatrixClient } from 'matrix-js-sdk';
import { getServiceClient } from './membership.js';
import { serverOfUser, type Peer } from './peers.js';
import type { RawEvent } from './publicWeb.js';
import { roomOriginServer } from './tenancy.js';

/**
 * Badges (docs/federation.md, "Badges"): a short coloured pill an admin hands to someone, a
 * "this person is special" mark. People have no say in them: they are made, given and taken
 * back only through `purrlor badges`, and live in a room only the service bot can write to.
 *
 * Each instance has one badge room, `#purrlor-badges:<server>`, of type `xyz.nekous.badges`,
 * created by the bot and world-readable. Two kinds of state event, both sent by the bot:
 *
 * - `xyz.nekous.badge`, state key = the badge's id: `{ text: "STAR", color: "#aa66ff" }`
 * - `xyz.nekous.badge_grant`, state key = a user: `{ badges: ["id", …] }`
 *
 * Peers' bots join each other's badge rooms like the emote libraries, and the app asks this
 * server for the lot (`GET /api/public/badges`). A room is trusted only for people on its own
 * server, and only what its creator (the bot) sent counts, so nobody else can forge a badge.
 */

export const BADGE_ROOM_TYPE = 'xyz.nekous.badges';
export const BADGE_EVENT = 'xyz.nekous.badge';
export const GRANT_EVENT = 'xyz.nekous.badge_grant';
export const BADGE_ID = /^[a-z0-9-]{1,32}$/;
export const BADGE_TEXT = /^[A-Za-z0-9!?*+$#&]{4}$/;
export const BADGE_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_BADGES = 200;
const MAX_PER_USER = 5;

export function badgeAlias(server: string): string {
  return `#purrlor-badges:${server}`;
}

export type Badge = { id: string; text: string; color: string };
export type BadgeDirectory = { badges: Badge[]; grants: Record<string, string[]> };

/** Whether `state` is `server`'s badge room: the type, that server's alias, created by someone there. */
export function isBadgeRoomOf(state: RawEvent[], server: string): boolean {
  const create = state.find((event) => event.type === 'm.room.create' && event.state_key === '');
  const alias = state.find((event) => event.type === 'm.room.canonical_alias' && event.state_key === '');
  return (
    create?.content?.type === BADGE_ROOM_TYPE &&
    alias?.content?.alias === badgeAlias(server) &&
    !!create.sender &&
    serverOfUser(create.sender) === server
  );
}

/** What a badge room says, counting only what its creator sent. Pure. */
export function readBadgeRoom(state: RawEvent[]): BadgeDirectory {
  const creator = state.find((event) => event.type === 'm.room.create' && event.state_key === '')?.sender;
  const badges = new Map<string, Badge>();
  const granted = new Map<string, string[]>();
  for (const event of state) {
    if (!creator || event.sender !== creator || !event.state_key) continue;
    const content = event.content ?? {};
    if (event.type === BADGE_EVENT) {
      const { text, color } = content as { text?: unknown; color?: unknown };
      if (BADGE_ID.test(event.state_key) && typeof text === 'string' && BADGE_TEXT.test(text) && typeof color === 'string' && BADGE_COLOR.test(color)) {
        if (badges.size < MAX_BADGES) badges.set(event.state_key, { id: event.state_key, text, color: color.toLowerCase() });
      }
    } else if (event.type === GRANT_EVENT && event.state_key.startsWith('@') && Array.isArray(content.badges)) {
      granted.set(event.state_key, content.badges.filter((id): id is string => typeof id === 'string'));
    }
  }
  const grants: Record<string, string[]> = {};
  for (const [user, ids] of granted) {
    const real = [...new Set(ids)].filter((id) => badges.has(id)).slice(0, MAX_PER_USER);
    if (real.length) grants[user] = real;
  }
  return { badges: [...badges.values()], grants };
}

async function stateOf(mx: MatrixClient, roomId: string): Promise<RawEvent[]> {
  return (await mx.roomState(roomId)) as unknown as RawEvent[];
}

/** This server's badge room, created (public, read-only to everyone but the bot) the first time. */
export async function ownBadgeRoom(mx: MatrixClient, server: string): Promise<string> {
  try {
    return (await mx.getRoomIdForAlias(badgeAlias(server))).room_id;
  } catch {
    // Not there yet.
  }
  const { room_id: roomId } = await mx.createRoom({
    name: 'Badges',
    topic: 'Purrlor badges: made and given by admins only (purrlor badges).',
    room_alias_name: 'purrlor-badges',
    visibility: 'private' as never,
    preset: 'public_chat' as never,
    creation_content: { type: BADGE_ROOM_TYPE },
    initial_state: [
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'world_readable' } },
      { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
    ],
    power_level_content_override: { events_default: 100, state_default: 100, invite: 100, users_default: 0 },
  });
  return roomId;
}

export async function readOwnBadges(mx: MatrixClient, server: string): Promise<BadgeDirectory> {
  const roomId = await ownBadgeRoom(mx, server);
  return readBadgeRoom(await stateOf(mx, roomId));
}

/** Makes a badge, or changes an existing one's text/colour. */
export async function setBadge(mx: MatrixClient, server: string, id: string, text: string, color: string): Promise<void> {
  const roomId = await ownBadgeRoom(mx, server);
  await mx.sendStateEvent(roomId, BADGE_EVENT as never, { text, color: color.toLowerCase() } as never, id);
  forgetBadges();
}

/** Deletes a badge: it stops showing for everyone who had it. */
export async function deleteBadge(mx: MatrixClient, server: string, id: string): Promise<void> {
  const roomId = await ownBadgeRoom(mx, server);
  await mx.sendStateEvent(roomId, BADGE_EVENT as never, {} as never, id);
  forgetBadges();
}

/** Sets who has what: `ids` replaces their list. Returns false if a badge doesn't exist or it's too many. */
export async function setGrants(mx: MatrixClient, server: string, userId: string, ids: string[]): Promise<boolean> {
  const roomId = await ownBadgeRoom(mx, server);
  const dir = readBadgeRoom(await stateOf(mx, roomId));
  if (ids.length > MAX_PER_USER || ids.some((id) => !dir.badges.some((badge) => badge.id === id))) return false;
  await mx.sendStateEvent(roomId, GRANT_EVENT as never, { badges: ids } as never, userId);
  forgetBadges();
  return true;
}

function joinedBadgeRoomOf(mx: MatrixClient, server: string): string | undefined {
  return mx
    .getRooms()
    .find(
      (room) =>
        room.getMyMembership() === 'join' &&
        room.getType() === BADGE_ROOM_TYPE &&
        roomOriginServer(mx, room.roomId) === server &&
        room.getCanonicalAlias() === badgeAlias(server)
    )?.roomId;
}

/** Joins `server`'s badge room, when it has one, and keeps it only if it is that. Part of each peer's sync. */
export async function joinPeerBadges(mx: MatrixClient, server: string): Promise<boolean> {
  if (joinedBadgeRoomOf(mx, server)) return true;
  let roomId: string;
  try {
    roomId = (await mx.getRoomIdForAlias(badgeAlias(server))).room_id;
  } catch {
    return false;
  }
  await mx.joinRoom(roomId, { viaServers: [server] });
  if (!isBadgeRoomOf(await stateOf(mx, roomId), server)) {
    console.warn(`Peering: left ${roomId}: not ${server}'s badge room`);
    await mx.leave(roomId).catch(() => undefined);
    return false;
  }
  return true;
}

export type PublicBadges = { badges: Record<string, Badge[]> };

let cache: { at: number; value: PublicBadges } | undefined;
const CACHE_MS = 60_000;

/** Every badge anyone here can see, by user ID: this server's own and its approved peers'. */
export async function readAllBadges(server: string, peers: Peer[], mx?: MatrixClient): Promise<PublicBadges> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const client = mx ?? (await getServiceClient());
  const out: Record<string, Badge[]> = {};
  const add = (host: string, dir: BadgeDirectory) => {
    const byId = new Map(dir.badges.map((badge) => [badge.id, badge]));
    for (const [user, ids] of Object.entries(dir.grants)) {
      if (serverOfUser(user) !== host) continue; // a room speaks only for its own server's people
      out[user] = ids.map((id) => byId.get(id)).filter((badge): badge is Badge => !!badge);
    }
  };
  try {
    add(server, await readOwnBadges(client, server));
  } catch (err) {
    console.warn(`Badges: couldn't read this server's badge room: ${(err as Error).message}`);
  }
  for (const peer of peers) {
    const roomId = joinedBadgeRoomOf(client, peer.serverName);
    if (!roomId) continue;
    try {
      const state = await stateOf(client, roomId);
      if (isBadgeRoomOf(state, peer.serverName)) add(peer.serverName, readBadgeRoom(state));
    } catch (err) {
      console.warn(`Badges: couldn't read ${peer.serverName}'s badge room: ${(err as Error).message}`);
    }
  }
  cache = { at: Date.now(), value: { badges: out } };
  return cache.value;
}

export function forgetBadges(): void {
  cache = undefined;
}
