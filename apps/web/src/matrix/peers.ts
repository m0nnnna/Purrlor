import type { MatrixClient } from 'matrix-js-sdk';
import { isDemoMode } from '../demo/demoMode';
import { serverOfUserId } from './homeServer';
import { getOpenIdTokenCached } from './openIdToken';

/**
 * The Purrlor instances this one federates with (docs/federation.md), and getting a peer's
 * person's profile room read here. The token server's bot joins approved peers' public rooms, so
 * this homeserver takes part in them and they read like local ones; this is the client's side.
 */

export type Peer = { serverName: string; name: string; url: string };

const PEERS_API = '/api/public/peers';
const JOIN_API = '/api/public/peers/join';
const PEERS_TTL_MS = 10 * 60_000;
const FAILED_TTL_MS = 60_000;

export function parsePeersAnswer(raw: unknown): Peer[] {
  const list = (raw as { peers?: unknown } | null)?.peers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const peer = entry as Record<string, unknown> | null;
    return peer && typeof peer.serverName === 'string' && peer.serverName && typeof peer.url === 'string'
      ? [{ serverName: peer.serverName, name: typeof peer.name === 'string' && peer.name ? peer.name : peer.serverName, url: peer.url }]
      : [];
  });
}

let cached: { at: number; ttl: number; promise: Promise<Peer[]> } | undefined;

/**
 * The approved peers, asked once and reused for ten minutes. None (no public web on this
 * deployment, an older token server, or no answer) is an empty list: federation is simply off.
 */
export function fetchPeers(): Promise<Peer[]> {
  if (isDemoMode()) return Promise.resolve([]);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.promise;
  const entry = { at: Date.now(), ttl: PEERS_TTL_MS, promise: Promise.resolve<Peer[]>([]) };
  entry.promise = fetch(PEERS_API)
    .then(async (response) => (response.ok ? parsePeersAnswer(await response.json()) : Promise.reject(new Error(`HTTP ${response.status}`))))
    .catch(() => {
      entry.ttl = FAILED_TTL_MS;
      return [];
    });
  cached = entry;
  return entry.promise;
}

/** The peer a user (or server name) belongs to, if it's one. */
export function peerOf(userIdOrServer: string, peers: Peer[]): Peer | undefined {
  const server = userIdOrServer.startsWith('@') ? serverOfUserId(userIdOrServer) : userIdOrServer;
  return peers.find((peer) => peer.serverName === server);
}

/** Can this homeserver read the room now (does it take part in it)? */
async function readable(mx: MatrixClient, roomId: string): Promise<boolean> {
  if (mx.getRoom(roomId)?.getMyMembership() === 'join') return true;
  try {
    await mx.getStateEvent(roomId, 'm.room.create', '');
    return true;
  } catch {
    return false;
  }
}

const readableRooms = new Map<string, { at: number; promise: Promise<boolean> }>();

/**
 * Makes a peer's person's profile room readable here: if this homeserver isn't in it yet, asks
 * the token server to have its bot join (POST /api/public/peers/join), which it does only for an
 * approved peer and only if the room is that person's. True once it can be read. Anyone on this
 * server, or on a server that isn't a peer, is answered by whether it's readable already.
 * Remembered per room; a "no" is asked again after a minute.
 */
export function ensurePeerRoomReadable(mx: MatrixClient, ownerId: string, roomId: string): Promise<boolean> {
  const known = readableRooms.get(roomId);
  if (known) {
    if (Date.now() - known.at < FAILED_TTL_MS) return known.promise;
    return known.promise.then((ok) => {
      if (ok) return true;
      readableRooms.delete(roomId);
      return ensurePeerRoomReadable(mx, ownerId, roomId);
    });
  }
  const promise = (async () => {
    if (await readable(mx, roomId)) return true;
    if (isDemoMode() || !peerOf(ownerId, await fetchPeers())) return false;
    try {
      const response = await fetch(JOIN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openid_token: await getOpenIdTokenCached(mx), user_id: ownerId, room_id: roomId }),
      });
      return response.ok && (await readable(mx, roomId));
    } catch {
      return false;
    }
  })();
  readableRooms.set(roomId, { at: Date.now(), promise });
  return promise;
}

/** For tests: forget what's been asked. */
export function resetPeersForTests(): void {
  cached = undefined;
  readableRooms.clear();
}
