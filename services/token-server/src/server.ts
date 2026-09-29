import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { validateOpenIdToken } from './openid.js';
import { checkMembership, getBotUserId, mayViewParticipants } from './membership.js';
import { grantsForPowerLevel } from './grants.js';
import { livekitRoomName } from './livekitRoomName.js';
import { fetchKlipySearch, fetchKlipyTrending, isGifsEnabled, type GifSearchResult } from './gifs.js';
import { consumeGifRateLimit } from './gifRateLimit.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
// Server-to-server LiveKit API host (RoomServiceClient), distinct from the wss:// URL clients
// use — same LiveKit deployment, just its plain HTTP endpoint reached over the docker network.
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'http://livekit:7880';

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
  process.exit(1);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());

function corsOriginAllowed(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    callback(null, true);
    return;
  }
  // Support a single leading-wildcard subdomain pattern, e.g. https://*.example.com — same
  // convention as cinny-voice's token server.
  const matched = ALLOWED_ORIGINS.some((allowed) => {
    if (!allowed.includes('*')) return false;
    const pattern = `^${allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '.*')}$`;
    return new RegExp(pattern).test(origin);
  });
  callback(null, matched);
}

const app = express();
app.use(cors({ origin: corsOriginAllowed }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'purrlor-token-server' });
});

/**
 * Self-description for clients: which Matrix account this deployment's membership-checking bot
 * runs as. The web client reads it so a Space admin never has to copy the bot's ID out of this
 * deployment's `.env`, and so new voice channels can invite it themselves at creation time
 * instead of leaving every one of them silently un-joinable (see apps/web/src/matrix/voiceBot.ts).
 * Unauthenticated on purpose — a service account's user ID is public the moment it's in a room.
 */
app.get('/api/livekit/config', async (_req, res) => {
  try {
    res.json({ botUserId: await getBotUserId() });
  } catch (err) {
    console.error('Failed to report bot user ID', err);
    res.status(503).json({ error: 'Service bot is not available' });
  }
});

app.post('/api/livekit/token', async (req, res) => {
  const openIdToken = req.body?.openid_token;
  const roomId = req.body?.room_id;
  if (!openIdToken || !roomId) {
    res.status(400).json({ error: 'openid_token and room_id are required' });
    return;
  }

  try {
    const userId = await validateOpenIdToken(openIdToken);
    const membership = await checkMembership(userId, roomId);

    // Two very different failures that used to collapse into the same "Not a member of this
    // room" 403 — which was actively misleading in the common case, where the caller *is* a
    // member and it's the service bot that was never invited. Split so the client can tell them
    // apart: one is fixed by inviting the bot (which the client does itself, then retries), the
    // other is a genuine permission answer.
    if (membership.status === 'bot-not-in-room') {
      res.status(409).json({
        error: 'The voice service bot has not been invited to this channel yet',
        code: 'voice_bot_not_in_room',
        botUserId: await getBotUserId().catch(() => undefined),
      });
      return;
    }
    // A valid OpenID token proves identity, not entitlement, and it validates for a user on any
    // federated homeserver — so "who are you" can't be the only question asked. This is "is this
    // room one of ours": a channel in a space this deployment actually serves (see tenancy.ts).
    // Without it, anyone could point the endpoint at a room of their own and be answered.
    if (membership.status === 'room-not-served') {
      res.status(403).json({
        error: 'This room is not a voice channel in a space served by this voice server',
        code: 'room_not_served',
      });
      return;
    }
    if (membership.status !== 'ok') {
      res.status(403).json({ error: 'Not a member of this room', code: 'not_a_member' });
      return;
    }

    const roomName = livekitRoomName(roomId);
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId,
      name: userId,
      ttl: '24h',
    });
    at.addGrant({ room: roomName, roomJoin: true, ...grantsForPowerLevel(membership.powerLevel) });

    const token = await at.toJwt();
    res.json({ token, roomName });
  } catch (err) {
    console.error('Failed to mint token', err);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Live participant tracking — queried on demand from LiveKit itself (RoomServiceClient) rather
// than cached from webhooks, so it's always current and can report per-participant mic/deafen
// state (which webhooks can't: LiveKit doesn't send a webhook when a track's mute state changes
// after publish, only on publish/unpublish — a client that reliably needs before-and-after mute
// state on every toggle would need webhooks anyway, but "what's true right now" is simpler and
// more reliable to just ask for than to keep a hand-rolled cache in sync).
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

type VoiceParticipant = { identity: string; micMuted: boolean; deafened: boolean };

/** One request can ask about this many channels at most — the channel list asks about one. */
const MAX_PARTICIPANT_ROOMS = 50;

// The unauthenticated GET this replaces told anyone who knew a room ID who was in its call.
// Answered explicitly so an old client gets a clear reason rather than a bare 404.
app.get('/api/livekit/rooms/participants', (_req, res) => {
  res.status(401).json({
    error: 'Participants now require authentication: POST openid_token and room_ids.',
    code: 'auth_required',
  });
});

/**
 * Who's in each voice channel right now, for the channel list — only for channels the caller is
 * a joined member of. Proven the same way a token request is (a Matrix OpenID token, so no
 * Matrix credentials ever reach this server); rooms the caller may not see are simply left out,
 * so the response never confirms whether a room ID the caller made up exists.
 */
app.post('/api/livekit/rooms/participants', async (req, res) => {
  const openIdToken = req.body?.openid_token;
  const requested = req.body?.room_ids;
  if (!openIdToken || !Array.isArray(requested)) {
    res.status(400).json({ error: 'openid_token and room_ids are required' });
    return;
  }
  const roomIds = [...new Set(requested.filter((id: unknown): id is string => typeof id === 'string' && !!id))].slice(
    0,
    MAX_PARTICIPANT_ROOMS
  );

  let userId: string;
  try {
    userId = await validateOpenIdToken(openIdToken);
  } catch {
    res.status(401).json({ error: 'Authentication failed' });
    return;
  }

  const result: Record<string, VoiceParticipant[]> = {};
  await Promise.all(
    roomIds.map(async (roomId) => {
      if (!(await mayViewParticipants(userId, roomId).catch(() => false))) return;
      try {
        const participants = await roomService.listParticipants(livekitRoomName(roomId));
        result[roomId] = participants.map((p) => {
          const micTrack = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
          return {
            identity: p.identity,
            micMuted: micTrack?.muted ?? true,
            // Broadcast by the client itself via localParticipant.setAttributes — LiveKit has
            // no built-in "deafened" concept (muting your own playback of others isn't
            // something the server can see), see VoiceChannelPanel.tsx's toggleDeafen.
            deafened: p.attributes.deafened === 'true',
          };
        });
      } catch {
        result[roomId] = []; // No LiveKit room yet (nobody's joined) — not an error.
      }
    })
  );

  res.json(result);
});

/**
 * Self-description for the client, same spirit as `/api/livekit/config`: whether this deployment
 * has a Klipy key configured at all, so the composer can hide its GIF button entirely instead of
 * showing one that 404s on every open. Unauthenticated — it reveals nothing beyond a boolean.
 */
app.get('/api/gifs/config', (_req, res) => {
  res.json({ enabled: isGifsEnabled() });
});

/**
 * Shared by both GIF endpoints below: without a Klipy key, disabled; otherwise the caller's
 * identity is proven the same way every other authenticated endpoint here proves it (a Matrix
 * OpenID token), then rate-limited per user before it ever reaches Klipy.
 */
async function handleGifRequest(
  req: Request,
  res: Response,
  fetchResult: (body: Record<string, unknown>, userId: string) => Promise<GifSearchResult>
): Promise<void> {
  if (!isGifsEnabled()) {
    res.status(404).json({ error: 'GIF search is not enabled on this server', code: 'gifs_disabled' });
    return;
  }

  const openIdToken = req.body?.openid_token;
  if (!openIdToken) {
    res.status(400).json({ error: 'openid_token is required' });
    return;
  }

  let userId: string;
  try {
    userId = await validateOpenIdToken(openIdToken);
  } catch {
    res.status(401).json({ error: 'Authentication failed' });
    return;
  }

  if (!consumeGifRateLimit(userId)) {
    res.status(429).json({ error: 'Too many GIF requests — try again shortly', code: 'gifs_rate_limited' });
    return;
  }

  try {
    res.json(await fetchResult(req.body ?? {}, userId));
  } catch (err) {
    console.error('GIF provider request failed', err);
    res.status(502).json({ error: 'GIF provider request failed' });
  }
}

app.post('/api/gifs/search', (req, res) => {
  void handleGifRequest(req, res, (body, userId) =>
    fetchKlipySearch({ query: body.query, cursor: body.cursor, limit: body.limit, locale: body.locale, userId })
  );
});

app.post('/api/gifs/trending', (req, res) => {
  void handleGifRequest(req, res, (body, userId) =>
    fetchKlipyTrending({ cursor: body.cursor, limit: body.limit, locale: body.locale, userId })
  );
});

app.listen(PORT, () => {
  console.log(`purrlor-token-server listening on :${PORT}`);
});
