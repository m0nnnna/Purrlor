import { ClientEvent, EventType, RoomStateEvent, type MatrixClient, type Room } from 'matrix-js-sdk';

/**
 * Joining a Space (or a channel) from something a person pastes or opens: a Purrlor invite link
 * (`https://<app>/?invite=<roomId>&via=<server>`, inviteLinks.ts, from any Purrlor instance), a
 * matrix.to link (`https://matrix.to/#/#space:server` or `…/#/!id?via=server`), or a bare address
 * (`#space:server`) or room ID. Used by the welcome guide's "Join with a link", the empty screen
 * for someone in no Space yet, and opening an invite link (useJoinFromInviteLink).
 */
export type JoinTarget = { target: string; via: string[] };

const ALIAS = /^#[^\s:]+:[^\s]+$/;
const ROOM_ID = /^![^\s/]+$/;

/** What to join, from pasted text, or undefined when it's none of the above. Pure. */
export function parseJoinTarget(text: string): JoinTarget | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  if (ALIAS.test(raw) || ROOM_ID.test(raw)) return { target: raw, via: [] };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // A Purrlor invite link.
  const invite = url.searchParams.get('invite');
  if (invite && ROOM_ID.test(invite)) return { target: invite, via: url.searchParams.getAll('via').filter(Boolean) };
  // A matrix.to link: everything after the # is the room and its own query.
  if (url.hostname === 'matrix.to' && url.hash.startsWith('#/')) {
    const [path, query = ''] = url.hash.slice(2).split('?');
    let target = path;
    try {
      target = decodeURIComponent(path);
    } catch {
      // Left as written.
    }
    if (ALIAS.test(target) || ROOM_ID.test(target)) {
      return { target, via: new URLSearchParams(query).getAll('via').filter(Boolean) };
    }
  }
  return undefined;
}

/**
 * Joins it: a plain join first, then through the link's servers only if that fails. The order
 * matters (useJoinFromInviteLink.ts has the detail): a plain join stays local when this homeserver
 * already knows the room, and `via` rescues one it can't reach otherwise.
 */
export async function joinTarget(mx: MatrixClient, { target, via }: JoinTarget): Promise<Room> {
  let room: Room;
  try {
    room = await mx.joinRoom(target);
  } catch (err) {
    // An address names its server (everything after the first colon, a port included); a room ID
    // from before room version 12 does too.
    const fallback = via.length ? via : target.includes(':') ? [target.slice(target.indexOf(':') + 1)] : [];
    if (!fallback.length) throw err;
    room = await mx.joinRoom(target, { viaServers: fallback });
  }
  return settled(mx, room.roomId);
}

/**
 * The joined room once its state has arrived with the next sync. `joinRoom` answers before that,
 * with a room that doesn't know yet what it is: opened straight away, a Space showed as a channel.
 * Gives up waiting after `timeoutMs` and hands back what there is.
 */
export function settled(mx: MatrixClient, roomId: string, timeoutMs = 10_000): Promise<Room> {
  const ready = () => {
    const room = mx.getRoom(roomId);
    return room?.currentState.getStateEvents(EventType.RoomCreate, '') ? room : undefined;
  };
  const now = ready();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const check = () => {
      const room = ready();
      if (room) finish(room);
    };
    const finish = (room: Room) => {
      clearTimeout(timer);
      mx.removeListener(ClientEvent.Room, check);
      mx.removeListener(RoomStateEvent.Events, check);
      resolve(room);
    };
    const timer = setTimeout(() => finish(mx.getRoom(roomId) ?? ({ roomId, isSpaceRoom: () => false } as unknown as Room)), timeoutMs);
    mx.on(ClientEvent.Room, check);
    mx.on(RoomStateEvent.Events, check);
  });
}
