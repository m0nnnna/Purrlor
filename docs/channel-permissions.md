# Channel permissions and slowmode

Per-channel control on top of a Space's roles: **who can post** (everyone, or moderators: an
announcement channel), **who can see the channel** (everyone in the Space, or moderators), and
**slowmode**. Code: `apps/web/src/matrix/channelPermissions.ts`, kept applied by
`features/channels/ChannelGovernance.tsx`, set from `ChannelPermissionsModal.tsx` (a channel's
"⋯" → Permissions). End-to-end tests: `apps/web/e2e/channel-permissions.spec.ts`.

## Roles have to reach the channels first

Matrix gives every room its own power levels, and a Space's don't cascade to its children. Before
this, promoting someone to moderator in Space Settings made them a moderator of the Space room
only. In the Space's channels they had whatever power the channel's creator had given them, usually
none: they couldn't delete a message, and nothing below could have meant "moderators".

So the Space's roles are now copied into its channels. The client of anyone who can change a
channel's power levels does it (the same approach `feedGovernance.ts` takes for feeds):

- everyone at moderator (50) or above in the Space gets the same level in each channel, and a v12
  room's privileged creators count as 100;
- someone who's a moderator in a channel but not in its Space goes back to the default, because
  roles come from the Space;
- nobody below moderator is touched (a member muted at -1 in one channel stays muted), and neither
  are the channel's own privileged creators;
- a client only changes levels below its own, to levels below its own, as the spec requires.

It runs at start and whenever a Space's roles, members or channels change, or a channel's power
levels or settings do. A change lands when someone able to make it next has Purrlor open; with
several admins online, they all compute the same result.

### Paced for big Spaces

The first run over an existing Space can mean one power-levels write per channel, and several
admins' clients would each make it. So the pass (`governSpaces`) is paced:

- **One writer.** Everyone able to change a channel's power levels works out the same order
  (`writerRank`: highest level first, then user ID). Before writing, a client waits 20 s per place
  ahead of it (at most 60 s), then looks again and only touches channels that still need it. With
  several admins online, the first writes and the rest find nothing left to do.
- **No burst.** Channels go one at a time with 400 ms between writes. A `429 M_LIMIT_EXCEEDED` is
  waited out for as long as the server asks (up to a minute, three tries) instead of dropping the
  write (`matrix/rateLimit.ts`).
- **A readable audit log.** The sync stamps its write with `xyz.nekous.role_sync` (the time). The
  audit log tells those writes from edits by hand (an edit carries the old stamp along unchanged)
  and folds the same change across a Space's channels into one line: "Alice applied the Space's
  roles: Bob is now a moderator · 12 channels".

Custom roles and channel-only moderators ride the same sync: see [roles.md](roles.md). Anyone a
custom role puts at or above its level is copied in like a moderator, and a channel's own
moderators (`moderators` in `xyz.nekous.channel_settings`) are raised to moderator in that channel
and never demoted by the pass. Promote someone in a channel by hand, without listing them there,
and the next pass still takes it back: roles come from the Space.

## Who can post

Native power levels, so the homeserver enforces it for every client:

| Setting | `m.room.power_levels` |
|---|---|
| Everyone | `events_default: 0` |
| Moderators only | `events_default: 50`, `events["m.reaction"]: 0` (everyone can still react) |

The composer checks the same levels (`canPostMessages`) and shows "Only moderators can post in
this channel." instead of a box whose every send would be refused. It already had this problem in
any room with raised levels; it just never came up before.

## Who can see the channel

"Moderators only" makes the channel **invite-only**, invites the Space's moderators, and removes
every other Space member from it. It uses a real Matrix access rule rather than a flag, so the
homeserver enforces it:

- Continuwuity leaves an invite-only child out of the Space hierarchy for anyone not in it
  (checked), so for everyone else the channel simply isn't listed.
- The governance pass keeps it current: someone who becomes a Space moderator is invited, and
  someone who stops being one is removed.
- A client accepts an invite to a channel of a Space it's in when a moderator of that Space sent
  it (`inviteFromSpaceModerator`), so new moderators don't have to find it in Invites. Any other
  invite still waits there, and a channel you've left is never re-joined.
- Never removed: yourself, the channel's creators, and the Space's voice service bot, which a voice
  channel needs in the room to let anyone into the call. Nobody outside the Space is removed.

Back to "Everyone in the Space" makes the join rule `restricted` to the Space again, so its members
can join (auto-join then takes them back in).

The choice is recorded as `moderators_only: true` in `xyz.nekous.channel_settings`: the join rule
alone can't tell a moderators-only channel from an ordinary private one, and only the former should
be kept to moderators. The join rule is written before the flag, so the flag never claims more than
the room enforces.

## Slowmode

Matrix has nothing like it, so it's a setting this app honours rather than one the server
enforces:

```json
// xyz.nekous.channel_settings (state, key "")
{ "slowmode_seconds": 30, "moderators_only": true }
```

Purrlor's composer holds a member's next message until `slowmode_seconds` have passed since their
last one, with a countdown; slash commands still work. Moderators aren't slowed down. Other Matrix
apps don't know the setting and aren't held, which the settings dialog says. Enforcing it for them
would need a bot to redact messages sent too soon, which is a bigger step than this feature warrants
until it's needed.

## UI

A channel row's hover toolbar is now the notification bell and a "⋯" menu (Permissions, Move up,
Move down, Remove from Space). Five separate buttons covered most of a hovered row, including the
channel name, and the hidden toolbar took clicks meant for the channel; it no longer takes pointer
events while hidden. Each setting in the dialog is only enabled for someone who can change it in
that channel.
