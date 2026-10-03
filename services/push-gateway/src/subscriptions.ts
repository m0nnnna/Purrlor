import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PushSubscription } from 'web-push';

/**
 * pushkey -> the browser's actual Web Push subscription (endpoint + encryption keys), and the
 * Matrix account that registered it. The pushkey is an opaque token the client generates (a
 * random UUID, apps/web/src/matrix/push.ts) and is what the homeserver's `/pushers/set` and later
 * notify calls address a device by; this map turns that key back into somewhere reachable.
 *
 * **Owned.** Registering and removing a subscription both require proving a Matrix identity
 * (server.ts), and a pushkey stays bound to the account that first registered it. Without that,
 * anyone who learned a pushkey could point it at their own browser and receive that person's
 * notifications — message previews included — or quietly switch them off.
 *
 * Kept in memory, and in SUBSCRIPTIONS_FILE when it's set (the data volume, so it's in backups too):
 * the web client registers again each time it starts (refreshBackgroundPush), but someone who
 * doesn't open the app after a restart should still get their notifications.
 */
type Entry = { subscription: PushSubscription; owner: string };
const subscriptionsByPushKey = new Map<string, Entry>();
let file: string | undefined;

function save(): void {
  if (!file) return;
  try {
    // Written aside, then moved over: a crash mid-write can't leave half a file behind.
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(subscriptionsByPushKey)), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error('Couldn’t save push subscriptions', err);
  }
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * A browser's subscription as a client sent it, or as it was saved: an https endpoint and both
 * keys, nothing else kept. Undefined when anything is missing or out of shape.
 */
export function parseSubscription(value: unknown): PushSubscription | undefined {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!sub || !isText(sub.endpoint, 2048) || !sub.endpoint.startsWith('https://')) return undefined;
  if (!isText(sub.keys?.p256dh, 512) || !isText(sub.keys?.auth, 512)) return undefined;
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

function parseEntry(value: unknown): Entry | undefined {
  const entry = value as { owner?: unknown; subscription?: unknown } | null;
  const subscription = parseSubscription(entry?.subscription);
  return entry && isText(entry.owner, 255) && subscription ? { owner: entry.owner, subscription } : undefined;
}

/** Where subscriptions are kept across restarts, and what was kept there last time. */
export function loadSubscriptions(path: string | undefined): void {
  file = path;
  subscriptionsByPushKey.clear();
  if (!path) return;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const [pushkey, value] of Object.entries(stored)) {
      const entry = parseEntry(value);
      if (entry && isText(pushkey, 512)) subscriptionsByPushKey.set(pushkey, entry);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.error('Couldn’t read saved push subscriptions', err);
  }
}

/** Saves (or refreshes) a subscription for its owner. `taken` when the pushkey belongs to someone else. */
export function claimSubscription(pushkey: string, owner: string, subscription: PushSubscription): 'saved' | 'taken' {
  const existing = subscriptionsByPushKey.get(pushkey);
  if (existing && existing.owner !== owner) return 'taken';
  const unchanged = existing && JSON.stringify(existing.subscription) === JSON.stringify(subscription);
  subscriptionsByPushKey.set(pushkey, { subscription, owner });
  // Every app start sends its subscription again; only a new or changed one is written.
  if (!unchanged) save();
  return 'saved';
}

/** Removes a subscription if `owner` registered it. Anything else — someone else's, or none at
 *  all — is left alone, and the caller answers the same either way. */
export function releaseSubscription(pushkey: string, owner: string): boolean {
  const existing = subscriptionsByPushKey.get(pushkey);
  if (!existing || existing.owner !== owner) return false;
  subscriptionsByPushKey.delete(pushkey);
  save();
  return true;
}

export function getSubscription(pushkey: string): Entry | undefined {
  return subscriptionsByPushKey.get(pushkey);
}

/** Every browser an account has registered, by pushkey — where its reminders go. */
export function subscriptionsOf(owner: string): { pushkey: string; subscription: PushSubscription }[] {
  return [...subscriptionsByPushKey].filter(([, entry]) => entry.owner === owner).map(([pushkey, entry]) => ({ pushkey, subscription: entry.subscription }));
}

/** For a pushkey the push service reports gone (404/410): forgotten regardless of owner. */
export function deleteSubscription(pushkey: string): void {
  if (subscriptionsByPushKey.delete(pushkey)) save();
}

/** How many browsers are registered, for the metrics. */
export function subscriptionCount(): number {
  return subscriptionsByPushKey.size;
}

/** Test seam. */
export function clearSubscriptions(): void {
  subscriptionsByPushKey.clear();
}
