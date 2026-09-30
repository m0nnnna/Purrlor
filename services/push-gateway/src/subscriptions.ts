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
 * In-memory and single-process, matching this project's other services. That's survivable
 * because the web client re-registers its subscription on every start (refreshBackgroundPush),
 * so a restarted gateway fills back up as people open the app.
 */
type Entry = { subscription: PushSubscription; owner: string };
const subscriptionsByPushKey = new Map<string, Entry>();

/** Saves (or refreshes) a subscription for its owner. `taken` when the pushkey belongs to someone else. */
export function claimSubscription(pushkey: string, owner: string, subscription: PushSubscription): 'saved' | 'taken' {
  const existing = subscriptionsByPushKey.get(pushkey);
  if (existing && existing.owner !== owner) return 'taken';
  subscriptionsByPushKey.set(pushkey, { subscription, owner });
  return 'saved';
}

/** Removes a subscription if `owner` registered it. Anything else — someone else's, or none at
 *  all — is left alone, and the caller answers the same either way. */
export function releaseSubscription(pushkey: string, owner: string): boolean {
  const existing = subscriptionsByPushKey.get(pushkey);
  if (!existing || existing.owner !== owner) return false;
  subscriptionsByPushKey.delete(pushkey);
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
  subscriptionsByPushKey.delete(pushkey);
}

/** Test seam. */
export function clearSubscriptions(): void {
  subscriptionsByPushKey.clear();
}
