# Webhooks

An outside service (CI, monitoring, a GitHub integration) posts into a channel with one HTTP
request, the way Discord's webhooks work. Code: `services/token-server/src/webhooks.ts` (the
endpoint), `apps/web/src/matrix/webhooks.ts` and `features/channels/WebhooksModal.tsx` (making
them), and the timeline's rendering in `MessageTimeline.tsx`. End-to-end tests:
`apps/web/e2e/webhooks.spec.ts`, against a real token server.

## Using one

A channel's "⋯" → **Webhooks** → name it → **Create webhook**. The URL is shown once:

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"content": "Build 42 passed", "username": "GitHub"}' \
  'https://token.example.com/api/webhooks/<room>/<webhook>/<token>'
```

It takes Discord's shape (`content`, optional `username`) or Slack's (`text`), so tools that
already post to either work unchanged. Up to 4,000 characters. Answers `204` when posted, `400`
for an empty or oversized message, `404` for an unknown webhook **or** a wrong token (the same
answer for both, so a URL can't be probed piece by piece), `409` in an encrypted channel, and
`429` past 10 messages in a burst or 30 a minute per webhook.

## Where it runs

In the **token server**, as its service bot. That bot already exists (voice uses it), already
has the tenancy rules for which rooms it may enter (`tenancy.ts`: local channels of Spaces this
deployment serves), and is already deployed and proxied. A separate service would have repeated
all three. It also means a Space needs a voice server set up (Space Settings → General) for
webhooks; the web app reads the service's address from that.

## How it's kept

```json
// xyz.nekous.webhook (state in the channel), state key = the webhook's id
{ "name": "CI", "token_sha256": "<hex>", "avatar_url": "mxc://…" }
```

- The web app draws a 32-byte random token and stores only its **SHA-256**. A channel's state is
  readable by its members, so the token itself exists only in the URL, which is shown once. The
  service compares hashes in constant time.
- The service keeps nothing. Each request reads the webhook from the room's state as the bot sees
  it, with the homeserver asked directly when the bot hasn't synced a just-made one.
- **Deleting** a webhook empties that state event, and its URL stops working immediately.
- Making one also brings the bot into the channel. In a channel only moderators can post in, it
  raises the bot to that level, which `ChannelGovernance` leaves alone (the bot is exempt from
  role syncing, see [channel-permissions.md](channel-permissions.md)).

## What gets posted

An `m.notice`: the default push rules keep notices quiet, so an integration that posts every build
doesn't ping anyone. The name travels as an [MSC4144](https://github.com/matrix-org/matrix-spec-proposals/pull/4144)
per-message profile:

```json
{ "msgtype": "m.notice", "body": "Build 42 passed", "xyz.nekous.webhook": "<webhook id>",
  "com.beeper.per_message_profile": { "id": "<webhook id>", "displayname": "GitHub" } }
```

Purrlor shows that name (and avatar) instead of the bot's, with an **APP** tag, and only for
messages the Space's own bot sent. Anyone can put a per-message profile on their own message, and
honouring it from a person would let them post as "GitHub" or as another member; the end-to-end
test checks that this doesn't work. Messages from different webhooks, or one webhook under
different names, aren't grouped together in the timeline. Clients without MSC4144 show them as
the bot.

## Limits

- **Not in encrypted channels.** The bot has no end-to-end encryption (`membership.ts` explains
  why), and a plaintext message in an encrypted channel is what its members were promised
  wouldn't happen. The menu doesn't offer webhooks there, and the endpoint refuses.
- **Incoming only.** Outgoing webhooks and bots with commands would need the service to read
  messages, which it deliberately never does.
- Avatars from the request (`avatar_url` in Discord's shape) are ignored: fetching arbitrary URLs
  from the server is a request-forgery risk. A webhook's avatar is an `mxc://` set on the webhook.
  It's set in the channel's Webhooks dialog: an optional image when you make the webhook, or
  Add / Change / Remove avatar on an existing one (`setWebhookAvatar` rewrites the webhook's state
  with the token's hash untouched, so its URL keeps working).

## Also fixed here

The bot didn't accept a Space invite when it arrived. The SDK emits the membership event before it
has applied the rest of the invite's stripped state, so at that moment the room had no
`m.room.create` and didn't look like a Space. The bot only got in on its next reconciliation pass,
up to a minute later. It now checks a tick later, when the room type is there.
