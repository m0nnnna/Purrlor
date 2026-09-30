import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { EventType, MsgType, type MatrixClient } from 'matrix-js-sdk';
import { botInServedRoom } from './membership.js';

/**
 * Incoming webhooks: an outside service (CI, a monitoring tool, a GitHub integration) posts into
 * a channel with one HTTP request, the way Discord's webhooks work. docs/webhooks.md has the
 * design; in short:
 *
 * - A webhook is a state event in the channel, `xyz.nekous.webhook` with the webhook's id as
 *   state key, made by a channel moderator in the web app. It holds a name, an optional avatar,
 *   and the **SHA-256 of its token**, never the token itself: the channel's members can read its
 *   state, and the URL (which carries the token) is shown once to whoever made it. Deleting the
 *   webhook empties the event, and the URL stops working at once.
 * - This service keeps nothing: every request reads the webhook from the room's state as the bot
 *   sees it, like the rest of the token server.
 * - The bot posts, and only in rooms it's allowed in at all (tenancy.ts: a local channel of a
 *   Space this deployment serves). Not in encrypted rooms: the bot has no end-to-end encryption
 *   (membership.ts), and a plaintext message in an encrypted channel is exactly what its members
 *   were promised wouldn't happen.
 * - Messages go out as `m.notice`, which default push rules keep quiet, so an integration posting
 *   every build doesn't ping anyone. The webhook's name (or the request's `username`) travels as
 *   an MSC4144 per-message profile, which the web app shows in place of the bot's own name.
 */

export const WEBHOOK_EVENT = 'xyz.nekous.webhook';
export const PER_MESSAGE_PROFILE = 'com.beeper.per_message_profile';

const MAX_TEXT = 4000;
const MAX_USERNAME = 80;

export type WebhookState = { name: string; avatarUrl?: string; tokenSha256: string };

export function parseWebhookState(content: unknown): WebhookState | undefined {
  const c = content as Record<string, unknown> | null;
  if (!c || typeof c.name !== 'string' || typeof c.token_sha256 !== 'string') return undefined;
  if (!/^[0-9a-f]{64}$/.test(c.token_sha256)) return undefined;
  return {
    name: c.name.slice(0, MAX_USERNAME),
    avatarUrl: typeof c.avatar_url === 'string' && c.avatar_url.startsWith('mxc://') ? c.avatar_url : undefined,
    tokenSha256: c.token_sha256,
  };
}

/** Constant-time: how long a wrong token takes to refuse says nothing about how wrong it was. */
export function tokenMatches(token: string, expectedSha256: string): boolean {
  const actual = createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(expectedSha256, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export type WebhookMessage = { text: string; username?: string };

/**
 * What to post, from the request body: Discord's `content` (and `username`), or Slack's `text`,
 * so tools that already speak either work unchanged. Undefined when there's nothing to post or
 * it's too long. Pure.
 */
export function parseWebhookBody(body: unknown): WebhookMessage | undefined {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return undefined;
  const text = typeof b.content === 'string' ? b.content : typeof b.text === 'string' ? b.text : undefined;
  if (!text || !text.trim() || text.length > MAX_TEXT) return undefined;
  const username = typeof b.username === 'string' && b.username.trim() ? b.username.trim().slice(0, MAX_USERNAME) : undefined;
  return { text, username };
}

/**
 * Per-webhook rate limit: a burst of `capacity`, refilling at `perMinute`. In memory, so it
 * resets with the process, which is fine for keeping a runaway script from flooding a channel.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity = 10,
    private readonly perMinute = 30,
    private readonly maxKeys = 10_000
  ) {}

  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 60_000) * this.perMinute);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      // Keys are whatever ids requests carry; drop the oldest rather than grow without bound.
      this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, bucket);
    return true;
  }
}

const limiter = new RateLimiter();

async function readWebhook(mx: MatrixClient, roomId: string, webhookId: string): Promise<WebhookState | undefined> {
  const synced = mx.getRoom(roomId)?.currentState.getStateEvents(WEBHOOK_EVENT, webhookId)?.getContent();
  // Just created: the bot may not have synced it yet, so ask the homeserver.
  const content = synced && Object.keys(synced).length > 0 ? synced : await mx.getStateEvent(roomId, WEBHOOK_EVENT, webhookId).catch(() => undefined);
  return parseWebhookState(content);
}

function isEncrypted(mx: MatrixClient, roomId: string): boolean {
  return !!mx.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomEncryption, '');
}

/** `POST /api/webhooks/:roomId/:webhookId/:token` */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const { roomId, webhookId, token } = req.params as Record<string, string>;
  const message = parseWebhookBody(req.body);
  if (!message) {
    res.status(400).json({ error: `Send JSON with "content" (or "text"): up to ${MAX_TEXT} characters` });
    return;
  }
  // Before any Matrix work, so a flood of bad requests costs almost nothing.
  if (!limiter.take(`${roomId}/${webhookId}`)) {
    res.status(429).json({ error: 'Too many messages; slow down' });
    return;
  }

  try {
    const mx = await botInServedRoom(roomId);
    const webhook = mx ? await readWebhook(mx, roomId, webhookId) : undefined;
    // One answer for "no such webhook" and "wrong token", so the URL can't be probed piece by piece.
    if (!mx || !webhook || !tokenMatches(token, webhook.tokenSha256)) {
      res.status(404).json({ error: 'Unknown webhook' });
      return;
    }
    if (isEncrypted(mx, roomId)) {
      res.status(409).json({ error: 'This channel is end-to-end encrypted, so webhooks can’t post in it' });
      return;
    }
    await mx.sendMessage(roomId, {
      msgtype: MsgType.Notice,
      body: message.text,
      'xyz.nekous.webhook': webhookId,
      [PER_MESSAGE_PROFILE]: {
        id: webhookId,
        displayname: message.username ?? webhook.name,
        ...(webhook.avatarUrl && { avatar_url: webhook.avatarUrl }),
      },
    } as any);
    res.status(204).end();
  } catch (err) {
    console.error(`Webhook ${webhookId} in ${roomId} failed`, err);
    res.status(502).json({ error: 'Couldn’t post the message' });
  }
}
