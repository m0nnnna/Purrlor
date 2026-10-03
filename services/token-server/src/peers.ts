/**
 * Peering: other Purrlor instances whose social side this one shows (docs/federation.md). An admin
 * approves each peer (`purrlor peers add`); nothing from a server that isn't approved reaches
 * Everyone, Discover or the public web here. This file is the pure part (unit-tested in
 * peers.test.ts); peering.ts does the joining, publicWebRoutes.ts and controlServer.ts the HTTP.
 */

import { cleanReason, terminalSafe } from './control.js';
import { PROFILE_ROOM_TYPE } from './publicWeb.js';

/** Bumped when what instances say to each other changes in a way an older one can't follow. */
export const FEDERATION_VERSION = 1;

export type Peer = {
  /** Its homeserver's server name: the part of its user IDs after the colon. */
  serverName: string;
  /** Where its app is, scheme and host only: `https://purr.example`. */
  url: string;
  /** What it calls itself, for labels ("on Purr Example"). */
  name: string;
  addedAt: string;
  addedBy: string;
};

/** What an instance says about itself at `GET /api/public/instance`. */
export type InstanceInfo = {
  software: 'purrlor';
  federation: number;
  serverName: string;
  name: string;
  url: string;
};

// A DNS name or an IP literal, with an optional port: what a Matrix server name may be.
const SERVER_NAME = /^(?=.{1,255}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const USER_ID = /^@([a-z0-9._=+-]{1,255}):([A-Za-z0-9.\-:[\]]{1,255})$/;
const LOCALPART = /^[a-z0-9._=+-]{1,255}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isServerName(value: unknown): value is string {
  return typeof value === 'string' && SERVER_NAME.test(value);
}

/** A display name with nothing a terminal or a label shouldn't get, at most 80 characters. */
export function cleanInstanceName(value: unknown, fallback: string): string {
  const name = [...terminalSafe(cleanReason(value))].slice(0, 80).join('').trim();
  return name || fallback;
}

/**
 * An instance's address as an admin typed it (`purr.example`, `https://purr.example/`, …) → its
 * origin, `https://purr.example`. HTTPS only, and nothing but a host and port: a path, a query,
 * or a user name in it is refused rather than quietly dropped.
 */
export function normalizePeerUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  if (!isServerName(url.host)) return undefined;
  return url.origin;
}

/** An instance's self-description, if it's a Purrlor instance this one can peer with. */
export function parseInstanceInfo(raw: unknown): InstanceInfo | { error: string } {
  if (!isRecord(raw) || raw.software !== 'purrlor') return { error: "That address doesn't answer as a Purrlor instance." };
  if (typeof raw.federation !== 'number' || raw.federation < 1) return { error: "That Purrlor instance doesn't federate yet (it needs updating)." };
  if (raw.federation > FEDERATION_VERSION) return { error: 'That Purrlor instance is newer than this one: update this one first.' };
  if (!isServerName(raw.serverName)) return { error: "That Purrlor instance didn't say which homeserver it runs." };
  const url = typeof raw.url === 'string' ? normalizePeerUrl(raw.url) : undefined;
  if (!url) return { error: "That Purrlor instance didn't give a usable address." };
  return { software: 'purrlor', federation: raw.federation, serverName: raw.serverName, name: cleanInstanceName(raw.name, raw.serverName), url };
}

export function parsePeers(text: string): Peer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const peers: Peer[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isServerName(entry.serverName) || seen.has(entry.serverName)) continue;
    const url = typeof entry.url === 'string' ? normalizePeerUrl(entry.url) : undefined;
    if (!url) continue;
    seen.add(entry.serverName);
    peers.push({
      serverName: entry.serverName,
      url,
      name: cleanInstanceName(entry.name, entry.serverName),
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
      addedBy: typeof entry.addedBy === 'string' ? entry.addedBy : '',
    });
  }
  return peers;
}

/**
 * A user ID from what a visitor or an admin typed, on this server or an approved peer:
 * `nibbles` and `@nibbles` are this server's, `@nibbles:server` is whichever server it names, if
 * that's this one or a peer. Anything else is undefined.
 */
export function knownUserId(input: string, localServer: string, peerServers: ReadonlySet<string>): string | undefined {
  const raw = input.trim();
  const full = USER_ID.exec(raw);
  if (full) return full[2] === localServer || peerServers.has(full[2]) ? raw : undefined;
  const localpart = raw.replace(/^@/, '').toLowerCase();
  return LOCALPART.test(localpart) ? `@${localpart}:${localServer}` : undefined;
}

export function serverOfUser(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

/** A person's address on this site: `@name` for this server's people, `@name:server` for a peer's. */
export function profilePath(userId: string, localServer: string): string {
  const server = serverOfUser(userId);
  const localpart = userId.slice(1, userId.indexOf(':'));
  return server === localServer ? `@${localpart}` : `@${localpart}:${server}`;
}

export type DirectoryEntry = {
  room_id: string;
  room_type?: string;
  world_readable?: boolean;
  join_rule?: string;
  num_joined_members?: number;
};

/**
 * What a peer's room directory lists that the bot should be in, under the caps: profile rooms
 * (anyone's Global posts and page), and public Spaces (their members' posts, for Everyone).
 * Only rooms anyone may read and join, the same test the app applies to its own directory.
 */
export function pickPeerRooms(entries: DirectoryEntry[], caps: { profiles: number; spaces: number }): { profiles: string[]; spaces: string[] } {
  const profiles: string[] = [];
  const spaces: string[] = [];
  for (const entry of entries) {
    if (!entry.world_readable || (entry.join_rule && entry.join_rule !== 'public')) continue;
    if (entry.room_type === PROFILE_ROOM_TYPE && profiles.length < caps.profiles && !profiles.includes(entry.room_id)) profiles.push(entry.room_id);
    if (entry.room_type === 'm.space' && spaces.length < caps.spaces && !spaces.includes(entry.room_id)) spaces.push(entry.room_id);
  }
  return { profiles, spaces };
}

/**
 * A peer's answer to "which of these people of yours do you keep off your public web"
 * (`POST /api/public/status`), kept only for the peer's own people: a peer can't hide or show
 * anyone else's.
 */
export function parsePeerStatus(raw: unknown, peerServer: string): { hidden: Set<string>; publicOff: Set<string> } | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.hidden) || !Array.isArray(raw.publicOff)) return undefined;
  const own = (list: unknown[]) =>
    new Set(list.filter((id): id is string => typeof id === 'string' && USER_ID.test(id) && serverOfUser(id) === peerServer));
  return { hidden: own(raw.hidden), publicOff: own(raw.publicOff) };
}
