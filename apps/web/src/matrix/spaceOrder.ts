import type { MatrixClient, Room } from 'matrix-js-sdk';

/**
 * Your order of Spaces in the server rail, arranged by dragging (features/servers/useSpaceDrag.ts).
 * Kept where Element keeps it, so the order is the same in both and on every device: each Space's
 * room account data `org.matrix.msc3230.space_order`, `{ "order": "<string>" }`. Spaces sort by that
 * string (printable ASCII, at most 50 characters, compared character by character); Spaces with no
 * order come after, by name.
 *
 * Moving a Space writes only its own order, a string between its new neighbours'. The first time
 * (no Space has one yet) or when there's no room left between two, every Space gets a fresh one.
 */
export const SPACE_ORDER_EVENT = 'org.matrix.msc3230.space_order';

const MIN = 0x20;
const MAX = 0x7e;
const MAX_LENGTH = 50;

/** A Space's order string, if it has a usable one. */
export function readSpaceOrder(room: Room): string | undefined {
  const order = room.getAccountData(SPACE_ORDER_EVENT)?.getContent<{ order?: unknown }>()?.order;
  return typeof order === 'string' && order.length > 0 && order.length <= MAX_LENGTH && /^[\x20-\x7e]+$/.test(order) ? order : undefined;
}

/** Plain code-point comparison: the order the spec's strings mean, unlike localeCompare. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Spaces in your order: ordered ones first, then the rest by name. Pure (given each room's data). */
export function sortSpaces(spaces: Room[]): Room[] {
  return spaces
    .map((room) => ({ room, order: readSpaceOrder(room) }))
    .sort((a, b) => {
      if (a.order && b.order) return compare(a.order, b.order) || compare(a.room.roomId, b.room.roomId);
      if (a.order) return -1;
      if (b.order) return 1;
      return a.room.name.localeCompare(b.room.name);
    })
    .map(({ room }) => room);
}

/**
 * A string that sorts after `before` and before `after` (either may be missing: the start or the
 * end), or undefined when there's none short enough. Pure.
 */
export function orderBetween(before: string | undefined, after: string | undefined): string | undefined {
  const a = before ?? '';
  let prefix = '';
  // While what's built so far equals the start of `after`, `after` limits the next character; once
  // it's below, anything may follow.
  let bounded = after !== undefined;
  for (let i = 0; i < MAX_LENGTH; i++) {
    const low = i < a.length ? a.charCodeAt(i) : MIN - 1;
    let high = MAX + 1;
    if (bounded) {
      // Equal to all of `after` so far: anything longer sorts after it.
      if (i >= after!.length) return undefined;
      high = after!.charCodeAt(i);
    }
    if (high - low > 1) return prefix + String.fromCharCode(Math.max(Math.floor((low + high) / 2), MIN));
    const char = Math.max(low, MIN);
    prefix += String.fromCharCode(char);
    if (char < high) bounded = false;
  }
  return undefined;
}

/** `count` order strings spread evenly, for giving every Space one. Pure. */
export function spreadOrders(count: number): string[] {
  const span = (MAX - MIN + 1) ** 2;
  const step = Math.floor(span / (count + 1));
  return Array.from({ length: count }, (_, i) => {
    const n = (i + 1) * step;
    return String.fromCharCode(MIN + Math.floor(n / (MAX - MIN + 1)), MIN + (n % (MAX - MIN + 1)));
  });
}

/**
 * The orders to write so `ordered` (the Spaces as they should now be) sorts that way, given their
 * current orders: just the moved one's when it fits between its neighbours, else everyone's. Pure.
 */
export function ordersFor(ordered: { id: string; order?: string }[], movedId: string): Map<string, string> {
  const at = ordered.findIndex((space) => space.id === movedId);
  const neighboursKnown = ordered.every((space) => space.id === movedId || !!space.order);
  if (at >= 0 && neighboursKnown) {
    const between = orderBetween(ordered[at - 1]?.order, ordered[at + 1]?.order);
    if (between) return new Map([[movedId, between]]);
  }
  const fresh = spreadOrders(ordered.length);
  return new Map(ordered.flatMap((space, i) => (space.order === fresh[i] ? [] : [[space.id, fresh[i]] as [string, string]])));
}

/** Moves a Space to `index` (among the Spaces as they were) and saves the order. */
export async function moveSpace(mx: MatrixClient, spaces: Room[], spaceId: string, index: number): Promise<void> {
  const from = spaces.findIndex((room) => room.roomId === spaceId);
  if (from < 0) return;
  const rest = spaces.filter((room) => room.roomId !== spaceId);
  const at = Math.max(0, Math.min(from < index ? index - 1 : index, rest.length));
  const ordered = [...rest.slice(0, at), spaces[from], ...rest.slice(at)];
  if (ordered.every((room, i) => room === spaces[i])) return;
  const writes = ordersFor(
    ordered.map((room) => ({ id: room.roomId, order: readSpaceOrder(room) })),
    spaceId
  );
  for (const [roomId, order] of writes) {
    await mx.setRoomAccountData(roomId, SPACE_ORDER_EVENT as never, { order } as never);
  }
}
