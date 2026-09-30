import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { isEncryptedRoom } from './encryption';
import { canSendStateEvent, userPowerLevel } from './permissions';
import { readVoiceServerConfig } from './voice';

/**
 * Incoming webhooks, the web app's half (the service's is services/token-server/src/webhooks.ts,
 * and docs/webhooks.md has the design). A channel moderator makes one here: the app draws a random
 * token, stores only its SHA-256 in the channel's state as `xyz.nekous.webhook`, makes sure the
 * Space's service bot is in the channel and can post there, and shows the URL once. Anything that
 * POSTs to it then posts into the channel as the bot, under the webhook's name.
 *
 * Webhooks go through the same service as the Space's voice (its token server), so a Space needs
 * a voice server set up for them. Not in encrypted channels: the bot has no end-to-end encryption.
 */

export const WEBHOOK_EVENT = 'xyz.nekous.webhook';
/** MSC4144: a name and avatar for one message, which this app shows instead of the sender's. */
export const PER_MESSAGE_PROFILE = 'com.beeper.per_message_profile';

export type Webhook = { id: string; name: string; createdBy: string; createdAt: number };

export function listWebhooks(channel: Room): Webhook[] {
  return (channel.currentState.getStateEvents(WEBHOOK_EVENT) as MatrixEvent[])
    .filter((event) => typeof event.getContent().name === 'string' && typeof event.getContent().token_sha256 === 'string')
    .map((event) => ({
      id: event.getStateKey() ?? '',
      name: event.getContent<{ name: string }>().name,
      createdBy: event.getSender() ?? '',
      createdAt: event.getTs(),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Webhooks need somewhere to go (the Space's voice server) and a channel they can post in. */
export function webhookService(mx: MatrixClient, space: Room): { baseUrl: string; botUserId: string } | undefined {
  const config = readVoiceServerConfig(mx, space);
  if (!config?.tokenEndpoint || !config.botUserId) return undefined;
  try {
    return { baseUrl: `${new URL(config.tokenEndpoint).origin}/api/webhooks`, botUserId: config.botUserId };
  } catch {
    return undefined;
  }
}

export function canManageWebhooks(channel: Room, userId: string): boolean {
  return !isEncryptedRoom(channel) && canSendStateEvent(channel, userId, WEBHOOK_EVENT);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function webhookUrl(baseUrl: string, roomId: string, webhookId: string, token: string): string {
  return `${baseUrl}/${encodeURIComponent(roomId)}/${encodeURIComponent(webhookId)}/${token}`;
}

/**
 * Makes a webhook and returns its URL, which is the only time the token exists anywhere but in
 * that URL. Brings the bot into the channel, and, in a channel only moderators can post in,
 * gives it the level it needs (ChannelGovernance leaves the bot's level alone).
 */
export async function createWebhook(mx: MatrixClient, channel: Room, space: Room, name: string): Promise<string> {
  const service = webhookService(mx, space);
  if (!service) throw new Error('Webhooks go through this Space’s voice server, which isn’t set up (Space Settings → General).');
  if (isEncryptedRoom(channel)) throw new Error('Webhooks can’t post in an end-to-end encrypted channel.');

  const id = crypto.randomUUID();
  const token = randomToken();
  await mx.sendStateEvent(channel.roomId, WEBHOOK_EVENT as any, { name: name.trim().slice(0, 80), token_sha256: await sha256Hex(token) } as any, id);

  const bot = service.botUserId;
  const membership = channel.getMember(bot)?.membership;
  if (membership !== 'join' && membership !== 'invite') await mx.invite(channel.roomId, bot);

  const levels = channel.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<Record<string, any>>() ?? {};
  const needed = levels.events?.[EventType.RoomMessage] ?? levels.events_default ?? 0;
  const myLevel = userPowerLevel(channel, mx.getUserId() ?? '');
  if (userPowerLevel(channel, bot) < needed && needed < myLevel) await mx.setPowerLevel(channel.roomId, bot, needed);

  return webhookUrl(service.baseUrl, channel.roomId, id, token);
}

/** Empty content: the service finds no webhook, and the URL stops working at once. */
export async function deleteWebhook(mx: MatrixClient, channel: Room, webhookId: string): Promise<void> {
  await mx.sendStateEvent(channel.roomId, WEBHOOK_EVENT as any, {} as any, webhookId);
}

/**
 * The name to show for a message a webhook posted, or undefined for any other message. Only when
 * the Space's own service bot sent it: anyone can put a per-message profile on their message, and
 * honoring it from a person would let them post as "GitHub" or as another member.
 */
export function webhookProfile(event: MatrixEvent, botUserId: string | undefined): { id: string; name: string; avatarUrl?: string } | undefined {
  if (!botUserId || event.getSender() !== botUserId) return undefined;
  const profile = event.getContent()[PER_MESSAGE_PROFILE] as { id?: unknown; displayname?: unknown; avatar_url?: unknown } | undefined;
  if (!profile || typeof profile.displayname !== 'string' || !profile.displayname.trim()) return undefined;
  return {
    id: typeof profile.id === 'string' ? profile.id : profile.displayname,
    name: profile.displayname.slice(0, 80),
    avatarUrl: typeof profile.avatar_url === 'string' && profile.avatar_url.startsWith('mxc://') ? profile.avatar_url : undefined,
  };
}
