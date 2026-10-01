import type { MatrixClient } from 'matrix-js-sdk';
import { getRuntimeConfig } from '../app/runtimeConfig';
import { getOpenIdTokenCached } from './openIdToken';

/**
 * Account-wide (not per-Space, unlike voice — this follows the person, not a community) config
 * pointing at this deployment's push gateway (services/push-gateway). Same custom-account-data
 * shape/cast convention as everywhere else in this codebase that needs a event type the SDK's
 * own typed maps don't know about (see voice.ts's `as any` on sendStateEvent).
 */
export const PUSH_GATEWAY_ACCOUNT_DATA_EVENT = 'xyz.nekous.push_gateway';
const APP_ID = 'xyz.nekous.webpush';
const PUSHKEY_STORAGE_KEY = 'nekous_push_pushkey';

/** The gateway you picked in Account Settings, else this deployment's own (runtimeConfig.ts) —
 *  so on a standard install, turning notifications on is one switch, not a URL to find. */
export function readPushGatewayUrl(mx: MatrixClient): string | undefined {
  const content = mx.getAccountData(PUSH_GATEWAY_ACCOUNT_DATA_EVENT as any)?.getContent<{ url?: string }>();
  return content?.url || getRuntimeConfig().pushGateway || undefined;
}

export async function setPushGatewayUrl(mx: MatrixClient, url: string): Promise<void> {
  await mx.setAccountData(PUSH_GATEWAY_ACCOUNT_DATA_EVENT as any, { url } as any);
}

/** One random id per browser profile, reused across enable/disable cycles so re-enabling after
 *  disabling still round-trips through the same pusher/subscription identity. */
function getOrCreatePushKey(): string {
  let key = localStorage.getItem(PUSHKEY_STORAGE_KEY);
  if (!key) {
    key = crypto.randomUUID();
    localStorage.setItem(PUSHKEY_STORAGE_KEY, key);
  }
  return key;
}

/** A fresh pushkey for this browser — when the old one is still registered to whoever used this
 *  browser before (the key is per browser, not per account). */
function rotatePushKey(): string {
  const key = crypto.randomUUID();
  localStorage.setItem(PUSHKEY_STORAGE_KEY, key);
  return key;
}

// PushManager wants the VAPID public key as raw bytes, but web-push (and every VAPID tool)
// hands it out base64url-encoded — same conversion every Web Push tutorial does, no library
// needed for one function.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushSupport = 'unsupported' | 'supported';

export function getPushSupport(): PushSupport {
  return 'serviceWorker' in navigator && 'PushManager' in window ? 'supported' : 'unsupported';
}

/** Whether *this device* currently has a live push subscription — the thing that's actually
 *  true per-browser-profile, independent of whether the account-wide gateway URL is configured. */
export async function isBackgroundPushEnabled(): Promise<boolean> {
  if (getPushSupport() === 'unsupported') return false;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return !!subscription;
}

/** Where enabling background push has got to, for the settings to show while it works. */
export type EnableStep = 'permission' | 'service-worker' | 'push-service' | 'gateway' | 'homeserver';

/** How long a step may take before it's reported as failed rather than left spinning. */
const STEP_TIMEOUT_MS = 20_000;
/**
 * The browser's own push service (Google's for Chrome, Mozilla's for Firefox) can be slow to
 * register a new subscription: 25-30 seconds is ordinary on some networks. So this one is generous.
 */
const PUSH_SERVICE_TIMEOUT_MS = 90_000;

/** `promise`, or a rejection with `message` if it hasn't settled within `ms`. */
export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Registers this device for background push: service worker, a real PushManager subscription,
 * handing that subscription to the gateway (so it knows where to actually deliver a push), and
 * a Matrix pusher pointing the homeserver at the gateway's notify endpoint. Must run from a real
 * user gesture — same requirement as Notification.requestPermission, which this also triggers
 * if not already granted.
 *
 * `onStep` hears each step as it starts. Every step but the permission prompt (which waits on the
 * person) has a time limit, so one that never answers ends in an error saying which it was, not a
 * button stuck on "Enabling…".
 */
export async function enableBackgroundPush(
  mx: MatrixClient,
  gatewayUrl: string,
  onStep: (step: EnableStep) => void = () => {}
): Promise<void> {
  onStep('permission');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
        : 'Notification permission was not granted'
    );
  }

  onStep('service-worker');
  const workerFailed = 'Your browser didn’t start Purrlor’s notification worker. Reload the page and try again.';
  const registration = await within(navigator.serviceWorker.register('/sw.js'), STEP_TIMEOUT_MS, workerFailed);
  await within(navigator.serviceWorker.ready, STEP_TIMEOUT_MS, workerFailed);

  onStep('push-service');
  const gatewayFailed = `Couldn’t reach the push gateway at ${gatewayUrl}.`;
  const { publicKey } = await within(
    fetch(`${gatewayUrl}/vapid-public-key`).then((r) => {
      if (!r.ok) throw new Error(gatewayFailed);
      return r.json() as Promise<{ publicKey: string }>;
    }),
    STEP_TIMEOUT_MS,
    gatewayFailed
  );
  const subscription = await within(
    registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }),
    PUSH_SERVICE_TIMEOUT_MS,
    'Your browser’s push service didn’t answer. A VPN, proxy or firewall can block it, and some browsers turn it off (in Brave: Settings → Privacy → “Use Google services for push messaging”).'
  ).catch((err: unknown) => {
    // The browser's own refusal (a DOMException such as "Registration failed - push service
    // error") means little without saying whose it is. By shape: not every DOMException is an Error.
    const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown };
    if (typeof message === 'string' && name !== 'Error') throw new Error(`Your browser’s push service refused: ${message}`);
    throw err;
  });

  onStep('gateway');
  let pushkey = getOrCreatePushKey();
  const register = () => within(registerWithGateway(mx, gatewayUrl, pushkey, subscription), STEP_TIMEOUT_MS, gatewayFailed);
  if ((await register()) === 'taken') {
    // Someone else who used this browser registered this key; this account gets its own.
    pushkey = rotatePushKey();
    if ((await register()) === 'taken') {
      throw new Error('Push gateway rejected the subscription');
    }
  }

  onStep('homeserver');
  await within(setOwnPusher(mx, gatewayUrl, pushkey), STEP_TIMEOUT_MS, 'Your homeserver didn’t answer. Try again in a moment.');
}

/**
 * Shows a notification through the service worker, the way a real push is shown, so turning
 * background push on ends with proof that notifications appear on this device. Never throws.
 */
export async function showBackgroundPushConfirmation(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    await registration?.showNotification('Notifications are on', {
      body: 'You’ll get Purrlor notifications on this device, even with it closed.',
      icon: '/favicon.ico',
      tag: 'purrlor-push-enabled',
    });
  } catch {
    // Only a confirmation.
  }
}

/**
 * Hands this browser's subscription to the gateway, proving which account it's for with a Matrix
 * OpenID token (the gateway binds a pushkey to the account that registered it, so nobody else can
 * redirect or remove it).
 */
async function registerWithGateway(
  mx: MatrixClient,
  gatewayUrl: string,
  pushkey: string,
  subscription: PushSubscription
): Promise<'ok' | 'taken'> {
  const openIdToken = await getOpenIdTokenCached(mx);
  const subscribeRes = await fetch(`${gatewayUrl}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: openIdToken, pushkey, subscription: subscription.toJSON() }),
  });
  if (subscribeRes.status === 403) return 'taken';
  if (!subscribeRes.ok) throw new Error('Push gateway rejected the subscription');
  return 'ok';
}

async function setOwnPusher(mx: MatrixClient, gatewayUrl: string, pushkey: string): Promise<void> {
  await mx.setPusher({
    app_id: APP_ID,
    app_display_name: 'Purrlor',
    device_display_name: navigator.userAgent.slice(0, 100) || 'Browser',
    kind: 'http',
    lang: navigator.language || 'en',
    pushkey,
    // user_id comes back to the gateway with every notification (the spec echoes a pusher's data),
    // so it can tell "replied to your comment" from "commented on your post" for this account.
    // (matrix-js-sdk types `data` as only url/format/brand; the spec allows any extra keys.)
    data: { url: `${gatewayUrl}/_matrix/push/v1/notify`, user_id: mx.getUserId() } as { url: string },
    append: false,
  });
}

/**
 * Re-registers this browser's existing subscription (and its pusher) at app start, if background
 * push is on here. Needs no permission prompt or gesture: the browser subscription already exists.
 *
 * Two jobs. The gateway keeps subscriptions in memory, so a restart or redeploy used to end
 * background push for everyone until each person switched it off and on again; this fills it back
 * up as people open the app. And re-setting the pusher gives older ones the `user_id` the gateway
 * uses to word "replied to your comment" correctly.
 */
export async function refreshBackgroundPush(mx: MatrixClient): Promise<void> {
  if (getPushSupport() === 'unsupported') return;
  const gatewayUrl = readPushGatewayUrl(mx);
  if (!gatewayUrl) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const pushkey = getOrCreatePushKey();
  // Registered to someone else who used this browser: leave it; turning push on here takes a new key.
  if ((await registerWithGateway(mx, gatewayUrl, pushkey, subscription)) === 'taken') return;
  await setOwnPusher(mx, gatewayUrl, pushkey);
}

export async function disableBackgroundPush(mx: MatrixClient, gatewayUrl: string): Promise<void> {
  const pushkey = getOrCreatePushKey();
  await mx.removePusher(pushkey, APP_ID).catch(() => {}); // already gone server-side is fine
  const openIdToken = await getOpenIdTokenCached(mx).catch(() => undefined);
  await fetch(`${gatewayUrl}/subscribe/${pushkey}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: openIdToken }),
  }).catch(() => {});

  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
