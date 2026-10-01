# Custom roles and channel-only moderators

A Space can add its own roles between Member and Admin, decide which role can do what, and give a
channel moderators of its own. Code: `apps/web/src/matrix/roles.ts` (the model),
`matrix/channelPermissions.ts` (carrying it into channels), `features/servers/SpaceRolesSettings.tsx`
(Space Settings → Roles), and `features/channels/ChannelPermissionsModal.tsx` (a channel's
moderators).

## Roles are tiers, not sets of flags

Matrix permissions are one integer per person per room (power levels). There's no role object, and
a person can't hold two levels at once. So a Purrlor role is a **named level**:

| Role | Level | Where it comes from |
|---|---|---|
| Admin | 100 | built in |
| *Senior mod* | 75 | a Space's own, say |
| Moderator | 50 | built in |
| *Helper* | 25 | a Space's own, say |
| Member | 0 | built in |

Each person has one role: the highest one at or below their level. Someone with a higher role can do
everything a lower one can. That's less than Discord, where roles stack, and it's what the protocol
can enforce: every check below is the homeserver's own, in every room, for every app.

A Space's roles are state in the Space:

```json
// xyz.nekous.roles (state, key "")
{ "roles": [{ "id": "k3x9a", "name": "Helper", "level": 25, "color": "#7fb2ff" }] }
```

Rules (`parseCustomRoles`): a level between 1 and 99, not 50 (Moderator's), not shared with another
role; a name of up to 32 characters; at most 20 roles. Anything else is ignored. The colour is used
for names in the member list and the timeline, and for the role's badge.

Deleting a role doesn't change anyone's level: its people show as the next role down until someone
gives them another.

## What each role can do

Space Settings → Roles sets the lowest role for six actions. Each is a Matrix threshold on the
Space's power levels:

| Action | Power-levels key | Default |
|---|---|---|
| Delete other people's messages | `redact` | 50 |
| Pin messages | `events["m.room.pinned_events"]` | 50 |
| Remove members | `kick` | 50 |
| Ban members | `ban` | 50 |
| Invite people | `invite` | 0 |
| Edit the Space's news ([news.md](news.md)) | `events["xyz.nekous.space_news"]` | 50 |

A client only offers levels at or below your own: the homeserver refuses the rest.

## Reaching the channels

Matrix doesn't cascade a Space's power levels to its channels, so the role sync
([channel-permissions.md](channel-permissions.md)) copies them in, as it already did for moderators:

- **People.** Everyone at or above the Space's lowest role (the lowest custom one, else Moderator)
  gets the same level in each channel. Someone at such a level in a channel but not in the Space goes
  back to the default.
- **Thresholds.** The first five above are copied into each channel (the news is the Space's own, so it stays there), as far as the admin's client doing
  it may change them. Only once the Space has its roles set up (the `xyz.nekous.roles` event exists):
  an older Space's channels keep what they were made with instead of all changing on the next pass.
- A custom role below Moderator is **not** a moderator anywhere else: it doesn't review reports,
  isn't exempt from slowmode, and isn't let into moderators-only channels.

## Channel-only moderators

A channel's Permissions has **Channel moderators**: Space members who moderate that channel and no
other. They're listed in the channel's settings:

```json
// xyz.nekous.channel_settings (state, key "")
{ "moderators": ["@ana:example.org"] }
```

The sync raises each to moderator (50) in that channel, or keeps their Space level if it's higher,
and never demotes them there. Taking someone off the list lets the next pass take the level back.
They also count as moderators for a moderators-only channel's members.

## Known limits

- One role per person, as above.
- Only Purrlor carries roles into channels; in another Matrix app, a channel's power levels are
  whatever the last Purrlor pass left.
- Changes land when an admin or moderator able to make them has Purrlor open (the same as the rest
  of the role sync).
