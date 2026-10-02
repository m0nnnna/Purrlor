import { createHmac, randomBytes } from 'node:crypto';

/** How long after its last ping an account still counts as online. Apps ping about once a minute. */
export const ONLINE_WINDOW_MS = 150_000;
/** Most accounts remembered at once, so a flood of pings can't grow memory without end. */
const MAX_TRACKED = 100_000;

/**
 * How many people have the app open: the one number behind "N online". Each signed-in app pings
 * about once a minute while it's showing; this keeps, in memory only, a keyed hash of the account
 * and when it last pinged, and forgets it after ONLINE_WINDOW_MS. The key is random and made fresh
 * every time the service starts, so the hashes can't be matched to accounts or across restarts.
 * Nothing is written to disk or logged, and no address or device is kept: a count is all it's for.
 */
export class OnlineCounter {
  private readonly key = randomBytes(32);
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly windowMs = ONLINE_WINDOW_MS) {}

  /** Counts this account as online now. */
  mark(userId: string, now = Date.now()): void {
    const id = createHmac('sha256', this.key).update(userId).digest('base64url');
    // Re-inserted, so the map stays oldest-first and pruning stops at the first one still in.
    this.lastSeen.delete(id);
    this.lastSeen.set(id, now);
    this.prune(now);
    while (this.lastSeen.size > MAX_TRACKED) this.lastSeen.delete(this.lastSeen.keys().next().value as string);
  }

  /** Accounts that pinged within the window. */
  count(now = Date.now()): number {
    this.prune(now);
    return this.lastSeen.size;
  }

  private prune(now: number): void {
    for (const [id, seen] of this.lastSeen) {
      if (now - seen < this.windowMs) break;
      this.lastSeen.delete(id);
    }
  }
}

/** The service's one counter. */
export const onlineCounter = new OnlineCounter();
