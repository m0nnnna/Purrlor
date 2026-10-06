import type { MatrixClient } from 'matrix-js-sdk';
import { getProfileRoomOf } from './extendedProfile';
import { readProfileFollows } from './profileFeed';

/**
 * **Top 8.** A friends block on a profile page lists up to eight people, and only people who
 * follow the owner back may be on it, so nobody is shown as someone's friend without having
 * chosen it. Following is public (each person's profile room carries who they follow,
 * profileFeed.ts), so this is checked, not trusted: when the page is drawn, and again when the
 * owner picks, a name is shown only if that person's own profile says they follow the owner.
 * A page edited by hand to list someone who doesn't follow back just doesn't show them.
 */

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; follows: Promise<string[] | undefined> }>();

/** Who `userId` follows, from their profile room's state. Undefined if they have no profile room. */
async function readFollowsOf(mx: MatrixClient, userId: string): Promise<string[] | undefined> {
  const profileRoom = await getProfileRoomOf(mx, userId).catch(() => undefined);
  if (!profileRoom) return undefined;
  const room = mx.getRoom(profileRoom);
  if (room?.getMyMembership() === 'join') {
    const events = room.currentState.getStateEvents('xyz.nekous.follow') ?? [];
    return readProfileFollows(
      events.map((event) => ({ type: event.getType(), state_key: event.getStateKey() ?? '', content: event.getContent() as Record<string, unknown> }))
    );
  }
  try {
    return readProfileFollows((await mx.roomState(profileRoom)) as { type: string; state_key?: string; content?: Record<string, unknown> }[]);
  } catch {
    return undefined;
  }
}

/** Who `userId` follows, cached for a minute so a Top 8 isn't eight requests per redraw. */
export function followsOf(mx: MatrixClient, userId: string, now = Date.now()): Promise<string[] | undefined> {
  const known = cache.get(userId);
  if (known && now - known.at < CACHE_MS) return known.follows;
  const follows = readFollowsOf(mx, userId);
  cache.set(userId, { at: now, follows });
  return follows;
}

/** Whether `userId` follows `ownerId`. False when it can't be told: unverified isn't shown. */
export async function followsBack(mx: MatrixClient, userId: string, ownerId: string): Promise<boolean> {
  return !!(await followsOf(mx, userId))?.includes(ownerId);
}

/** The people from `userIds` who follow `ownerId`, in the order given. */
export async function verifiedFriends(mx: MatrixClient, ownerId: string, userIds: string[]): Promise<string[]> {
  const checked = await Promise.all(userIds.map(async (userId) => ((await followsBack(mx, userId, ownerId)) ? userId : undefined)));
  return checked.filter((userId): userId is string => !!userId);
}

/** Forgets what's cached, so a follow just made shows at once (and so tests start clean). */
export function forgetFollowCache(): void {
  cache.clear();
}
