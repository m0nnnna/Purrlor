import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import { validateOpenIdToken } from './openid.js';
import { describePostActivity } from './postActivity.js';
import { loadReminders, parseReminders, reminderCount, setReminders, takeDue } from './reminders.js';
import {
  claimSubscription,
  deleteSubscription,
  getSubscription,
  loadSubscriptions,
  parseSubscription,
  releaseSubscription,
  subscriptionCount,
  subscriptionsOf,
} from './subscriptions.js';
import { ErrorLog, captureProcessErrors } from './errorLog.js';
import { standardMetrics } from './metrics.js';
import { finalErrorHandler, opsRouter } from './ops.js';

// The build this is (a commit, set by the image build), for `purrlor metrics` and error reports.
const VERSION = process.env.PURRLOR_VERSION || undefined;

// Errors and metrics for the operator (ops.ts, docs/deployment.md "Errors and metrics"). First, so
// a failure anywhere below is recorded too.
const ops = standardMetrics('purrlor_push_gateway');
const errorLog = new ErrorLog(process.env.ERRORS_FILE || undefined, (report) => ops.errors.inc({ source: report.source }));
captureProcessErrors(errorLog, VERSION);
const pushes = ops.metrics.counter('pushes_total', 'Push messages, by how they went');
ops.metrics.gauge('subscriptions', 'Browsers registered for notifications', subscriptionCount);
ops.metrics.gauge('reminders_waiting', 'Reminders waiting to fire', reminderCount);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3002;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
// Per the Web Push spec, a contact the push service (e.g. Google's FCM) can reach out to if
// this deployment is misbehaving — a mailto: address or this deployment's own https:// URL.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set — generate a pair with `npx web-push generate-vapid-keys`');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Where reminders are kept across restarts (reminders.ts). Unset: memory only.
loadReminders(process.env.REMINDERS_FILE || undefined);
// And browsers' subscriptions (subscriptions.ts), so notifications keep coming after a restart.
loadSubscriptions(process.env.SUBSCRIPTIONS_FILE || undefined);
/** How often due reminders are looked for. */
const REMINDER_SWEEP_MS = 30_000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());

function corsOriginAllowed(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    callback(null, true);
    return;
  }
  const matched = ALLOWED_ORIGINS.some((allowed) => {
    if (!allowed.includes('*')) return false;
    // The * escaped too, so it can be found and swapped for one subdomain (unescaped, it quantified
    // the character before it and no subdomain ever matched; the token server's corsPolicy.ts).
    const pattern = `^${allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '[^./]+')}$`;
    return new RegExp(pattern).test(origin);
  });
  callback(null, matched);
}

const app = express();
app.use(ops.measure);
app.use(cors({ origin: corsOriginAllowed }));
app.use(express.json());
app.use(opsRouter({ token: process.env.METRICS_TOKEN ?? '', service: 'push gateway', version: VERSION, metrics: ops, errors: errorLog }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'purrlor-push-gateway' });
});

// Lets the client fetch the current public key at runtime rather than hardcoding it into the
// web app's build — regenerating the VAPID pair needs no frontend rebuild.
app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

/**
 * Who's asking, from a Matrix OpenID token in the body — the same proof the token server takes,
 * validated the same way (openid.ts is a copy of the token server's), so no Matrix credentials
 * ever reach this service. Undefined when there's no token or it doesn't check out.
 */
async function callerOf(body: unknown): Promise<string | undefined> {
  const openIdToken = (body as { openid_token?: unknown } | undefined)?.openid_token;
  if (!openIdToken || typeof openIdToken !== 'object') return undefined;
  return validateOpenIdToken(openIdToken as Parameters<typeof validateOpenIdToken>[0]).catch(() => undefined);
}

/**
 * Registers (or refreshes) this browser's Web Push subscription under its pushkey, for the
 * Matrix account proven by `openid_token`. A pushkey already registered by a different account
 * is refused: otherwise knowing someone's pushkey would be enough to redirect their
 * notifications to your own browser.
 */
app.post('/subscribe', async (req, res) => {
  const pushkey: unknown = req.body?.pushkey;
  // Only the parts Web Push uses are kept (and saved): an https endpoint and its two keys.
  const subscription = parseSubscription(req.body?.subscription);
  if (typeof pushkey !== 'string' || !pushkey || pushkey.length > 512 || !subscription) {
    res.status(400).json({ error: 'pushkey and subscription are required' });
    return;
  }
  const owner = await callerOf(req.body);
  if (!owner) {
    res.status(401).json({ error: 'A valid openid_token is required', code: 'auth_required' });
    return;
  }
  if (claimSubscription(pushkey, owner, subscription) === 'taken') {
    res.status(403).json({ error: 'That pushkey belongs to another account', code: 'pushkey_taken' });
    return;
  }
  res.status(204).end();
});

/**
 * Forgets a subscription — only for the account that registered it. Answers 204 whether or not
 * there was anything to remove, so it confirms nothing about pushkeys the caller doesn't own.
 */
app.delete('/subscribe/:pushkey', async (req, res) => {
  const owner = await callerOf(req.body);
  if (!owner) {
    res.status(401).json({ error: 'A valid openid_token is required', code: 'auth_required' });
    return;
  }
  releaseSubscription(req.params.pushkey, owner);
  res.status(204).end();
});

/**
 * Replaces the caller's reminders with this list (reminders.ts). The client sends its whole list
 * whenever it changes, and on start, so nothing here needs to track individual changes.
 */
app.put('/reminders', async (req, res) => {
  const owner = await callerOf(req.body);
  if (!owner) {
    res.status(401).json({ error: 'A valid openid_token is required', code: 'auth_required' });
    return;
  }
  setReminders(owner, parseReminders(req.body?.reminders));
  res.status(204).end();
});

/**
 * Sends one Web Push message to a subscription. A subscription the push service says is gone for
 * good (404/410: browser uninstalled, storage cleared) is forgotten and reported back; anything
 * else (a transient network or 5xx error) is logged and left for the next message.
 */
async function deliver(pushkey: string, subscription: webpush.PushSubscription, payload: string): Promise<'sent' | 'gone' | 'failed'> {
  const result = await send(pushkey, subscription, payload);
  pushes.inc({ result });
  return result;
}

async function send(pushkey: string, subscription: webpush.PushSubscription, payload: string): Promise<'sent' | 'gone' | 'failed'> {
  try {
    await webpush.sendNotification(subscription, payload);
    return 'sent';
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      deleteSubscription(pushkey);
      return 'gone';
    }
    console.error(`Failed to deliver push to ${pushkey}`, err);
    return 'failed';
  }
}

/** Fires every reminder that's due, to each browser its account has registered. */
async function sweepReminders(): Promise<void> {
  for (const { owner, reminder } of takeDue()) {
    const payload = JSON.stringify({
      title: reminder.title,
      body: reminder.body,
      roomId: reminder.roomId,
      eventId: reminder.eventId,
      tag: reminder.id,
    });
    await Promise.all(subscriptionsOf(owner).map(({ pushkey, subscription }) => deliver(pushkey, subscription, payload)));
  }
}
setInterval(() => void sweepReminders().catch((err) => console.error('Reminder sweep failed', err)), REMINDER_SWEEP_MS);

type NotifyDevice = {
  app_id: string;
  pushkey: string;
  pushkey_ts?: number;
  data?: Record<string, unknown>;
  tweaks?: { highlight?: boolean };
};
type NotifyBody = {
  notification: {
    id?: string;
    room_id?: string;
    room_name?: string;
    event_id?: string;
    /** The event's type — part of the spec's notification object, alongside its content. */
    type?: string;
    sender?: string;
    sender_display_name?: string;
    content?: { body?: unknown; msgtype?: unknown; 'xyz.nekous.reply_to'?: { sender?: unknown } };
    counts?: { unread?: number };
    devices: NotifyDevice[];
  };
};

/**
 * The Matrix Push Gateway API (the one part of this service a homeserver actually calls) —
 * https://spec.matrix.org/latest/push-gateway-api/. It POSTs here whenever a pusher's user has a
 * notify-worthy event, we translate that into a real Web Push message via the subscription
 * `/subscribe` stored earlier, and report back which pushkeys are dead so the homeserver stops
 * trying them (`rejected`, part of the spec, not a Purrlor invention).
 */
app.post('/_matrix/push/v1/notify', async (req, res) => {
  const body = req.body as NotifyBody | undefined;
  const notification = body?.notification;
  if (!notification || !Array.isArray(notification.devices)) {
    res.status(400).json({ error: 'notification.devices is required' });
    return;
  }

  const title = notification.sender_display_name || notification.sender || 'New message';
  // Encrypted-room events arrive here still encrypted (the homeserver can't read them either) —
  // content.body is only ever real plaintext for an unencrypted room, so anything else falls
  // back to a generic line rather than showing ciphertext or garbage.
  const rawBody = notification.content?.body;
  const text = typeof rawBody === 'string' && rawBody.trim() ? rawBody : '';
  const previewBody = text || 'Sent a message';
  // Likes, comments, replies and mentions around posts (see postActivity.ts).
  const device = notification.devices[0];
  const postActivity = describePostActivity({
    type: notification.type,
    content: notification.content,
    recipient: typeof device?.data?.user_id === 'string' ? device.data.user_id : undefined,
    highlight: !!device?.tweaks?.highlight,
  });
  const payload = JSON.stringify({
    title,
    body: postActivity ?? (notification.room_name ? `${notification.room_name}: ${previewBody}` : previewBody),
    roomId: notification.room_id,
    eventId: notification.event_id,
    unreadCount: notification.counts?.unread,
  });

  const rejected: string[] = [];
  await Promise.all(
    notification.devices.map(async (device) => {
      const entry = getSubscription(device.pushkey);
      if (!entry) {
        rejected.push(device.pushkey);
        return;
      }
      // The notify API itself carries no credentials (that's the Matrix spec's design; the
      // pushkey being unguessable is what protects it). As a second check, a pusher that says
      // whose it is (data.user_id, set by the web client) must match the subscription's owner.
      const claimedUser = device.data?.user_id;
      if (typeof claimedUser === 'string' && claimedUser !== entry.owner) return;
      // A pushkey the push service says is gone is reported back, so the homeserver stops trying it.
      if ((await deliver(device.pushkey, entry.subscription, payload)) === 'gone') rejected.push(device.pushkey);
    })
  );

  res.json({ rejected });
});

app.use(finalErrorHandler);

app.listen(PORT, () => {
  console.log(`purrlor-push-gateway listening on :${PORT}`);
});
