# Federation between Purrlor instances

How approved Purrlor instances share their social side: people follow and read each other across
instances, peers' public posts reach Everyone, peers' public Spaces show in Discover, and signed-out
visitors see peers' opted-in pages and Global posts. This is the contract the web client's
federation work builds on. The plan is the Claude Docs doc "Purrlor: federated social features".

The service side is `services/token-server/src/peers.ts` (the pure rules, tested in `peers.test.ts`),
`peering.ts` (the bot's joins), `publicWebRoutes.ts` (the HTTP side) and `controlServer.ts`
(`purrlor peers`).

## Why the bot joins

Posts, likes, comments, follows, Top 8 and guestbooks are Matrix rooms and events, so they already
cross servers. What doesn't is **reading without joining**: the app reads profile rooms, feed rooms
and Spaces it hasn't joined (`/messages`, `/state`), which a homeserver only answers for rooms it
already takes part in. Matrix has no way to read a room on another server without joining it.

So each instance's service bot (the token server's) joins its peers' public rooms. Once it has, this
homeserver takes part in them, and every read path the app already has works for every local user,
signed in or out, exactly as for local rooms.

## Peers

An admin approves each peer: `purrlor peers add <its address>` (`docs/admin-control.md`, "Peers").
Peering is one-sided: adding a peer decides what **this** instance shows from it. For both sides to
see each other, each adds the other. `purrlor peers remove <server name>` is the defederation switch:
the bot leaves every room created on that server, and its people and Spaces disappear from
Everyone, Discover and the public web here.

Nothing from a server that isn't an approved peer reaches Everyone, Discover or the public web.
(Matrix itself still federates with everyone, as before: DMs, Spaces people join by invite or link,
and so on. Blocking a server at the Matrix level is the homeserver's own setting.)

## What the bot joins

Per peer, every ten minutes (and right after it's added; `purrlor peers sync` for now), from the
peer's room directory read over federation (`publicRooms` with `server`):

| What | Which | Cap (setting) |
| --- | --- | --- |
| Profile rooms (`xyz.nekous.profile`) | Listed, world-readable, public join rule | 200 per peer (`PEER_MAX_PROFILES`) |
| Public Spaces | Listed, world-readable, public join rule | 40 per peer (`PEER_MAX_SPACES`) |
| Feed rooms in those Spaces | The peer's own people's (from their member events' `xyz.nekous.feed_room`), up to 100 per Space | |
| A followed person's profile room | On request (`POST /api/public/peers/join`, below) | |

`PEER_SPACE_FEEDS=off` leaves Spaces and their feeds out (Global posts only). Nothing past 1000 rooms
per peer in all. Each room is checked once joined and left if it isn't what it claimed: a profile
room must belong to someone on that peer (its feed marker's owner, cross-checked against its
creator), a feed room to that member of that Space. The bot never posts. Joining a peer's Space
gives nothing back: voice is only served in Spaces created on this server (`tenancy.ts`).

The bot shows in peers' Spaces' member lists. That's the cost of reading them.

## API

All under `/api/public/` (which every install's nginx already forwards to the token server).

### `GET /api/public/instance`

What this instance is, asked by an admin adding it as a peer:

```json
{ "software": "purrlor", "federation": 1, "serverName": "purr.example", "name": "Purr", "url": "https://purr.example" }
```

`name` is `PURRLOR_INSTANCE_NAME`, or the server name. `url` is `PUBLIC_WEB_URL`, or the address it
was asked at. `federation` is bumped only when instances need to know a change in what they say to
each other.

### `GET /api/public/peers`

The approved peers, for the client to know which directories to read and how to label them:

```json
{ "peers": [{ "serverName": "cats.example", "name": "Cats", "url": "https://cats.example" }] }
```

### `POST /api/public/status`

Asked by peers, about this instance's own people: which of them it keeps off its public web.

```json
// request
{ "users": ["@luna:purr.example", "@sol:purr.example"] }
// answer: only this server's people, at most 500 asked
{ "hidden": ["@sol:purr.example"], "publicOff": [] }
```

### `POST /api/public/peers/join`

A signed-in person here followed (or opened) a peer's person whose profile room the bot isn't in
yet. The client asks, then reads the room as usual once it answers.

```json
{ "openid_token": { … }, "user_id": "@mochi:cats.example", "room_id": "!abc:cats.example" }
```

| Answer | When |
| --- | --- |
| `200 { "joined": true }` | The bot is in it (already, or now) and it's that person's profile room |
| `400 bad_request` | `user_id` isn't a peer's person, or no `room_id` |
| `401` | The OpenID token didn't check out |
| `403 not_local` | The caller isn't on this server |
| `403 not-a-peer` | That person's server isn't an approved peer |
| `404 not-theirs` | The room isn't that person's profile room (the bot left it again) |
| `429` | More than 20 a minute from one person |
| `503 full` | The bot reads as many rooms from that peer as it will |

## The public web

Approved peers' people are shown like this server's own (`docs/public-web.md`), with three more
rules:

- **Their own instance decides first.** Each feed refresh asks every peer `POST /status` about its
  people in the snapshot. Anyone it hides or keeps off its public web is hidden or kept off here
  too. A peer that can't be asked is answered from its last reply for half an hour, then all its
  people are hidden: when in doubt, a peer's person isn't shown.
- **This instance's admins can hide them too**: `purrlor pages hide @name:peer.example`, `purrlor
  takedown user @name:peer.example`, and so on.
- **Addresses carry the server**: `/@mochi:cats.example`, `/@mochi:cats.example/post/<id>`. Link
  previews use the same.

Their media comes through this instance's media route, fetched over federation by the homeserver,
under the same rules as local media.

## The web client

- **Peers** (`matrix/peers.ts`): `fetchPeers()` reads `GET /api/public/peers`, reused for ten
  minutes; none (an older token server, no public web) means federation is off.
- **Everyone** (`useGlobalFeed`): reads this server's directory and every peer's
  (`listPeerDirectories`, `publicRooms` with `server`, each peer under the same caps as this
  server's, reused for five minutes). A peer's room the bot hasn't joined yet doesn't load this
  time and isn't counted as unreadable; it will be there within ten minutes.
- **Following and opening a peer's person** (`loadUserProfileSource`, `useProfilePage`): their
  profile room comes from their extended profile as for anyone; if this homeserver can't read it yet,
  `ensurePeerRoomReadable` asks `POST /api/public/peers/join` and reads it once the bot is in. A
  followed peer's Space counts as public when the peer's directory lists it.
- **Discover**: with peers, a row of tabs picks whose Spaces ("This server", then each peer by
  name); a peer's Space is joined through that peer (`viaServers`).
- **Handles and addresses** (`matrix/homeServer.ts`): once the app knows its own server (from the
  client, or signed out from `GET /api/public/instance`), a peer's person shows as
  `@name:server` (`handleFor`) and their address is `/@name:server` (`publicPagePath`), here and in
  copied links. This server's people stay `@name`.
- **Signed out**: `/@name:server` and `/@name:server/post/<id>` work like `/@name`; the API takes
  `name:server` with or without its `@`.

Not done yet: finding a peer's person by name in search (a full `@name:server` ID works wherever a
user ID is typed), and a peer's person whose extended profile doesn't come through federation and
who isn't in the first pages of their instance's directory.

## Verify first

The plan's "Verify first" checklist is what this design rests on; its results go in the plan. If
remote extended profiles don't come through federation, the client finds profile rooms through the
peer's directory instead. If the remote directory ignores the room type filter, `pickPeerRooms`
already keeps only the right types.
