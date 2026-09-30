# Channel and Space notification settings

Per-channel, per-DM and per-Space control over what notifies you, with Discord's three choices:
**All messages**, **Only @mentions**, **Nothing**. The data layer is `apps/web/src/matrix/notificationSettings.ts`,
kept applied by `apps/web/src/features/notifications/NotificationRules.tsx`. The menus that set it
are still to be built (see "UI" below).

## Everything is push rules

Every place a notification shows up already follows the user's push rules:

- unread and mention badges are counted by the homeserver (`useUnreadCounts.ts`);
- desktop notifications use `getPushActionsForEvent`, the same rules evaluated in the client
  (`DesktopNotifications.tsx`);
- background push only happens when the homeserver's rules say notify, so the push gateway only
  hears about what should notify.

So the settings are push rules, and nothing else has to change. Each level is one rule, keyed by
the room ID, the same rules Element and Cinny write for their own per-room settings:

| Level | Rule | Why it works |
|---|---|---|
| All messages | none (server defaults) | the default rules notify for every message |
| Only @mentions | `room` rule `<roomId>`, `actions: []` | mention rules are `override` rules, which run before `room` rules, so mentions still notify; plain messages stop at this rule |
| Nothing | `override` rule `<roomId>`, condition `room_id == <roomId>`, `actions: []` | runs before the mention rules too |

Checked against Continuwuity (unread counts after a plain message and a mention): no rule notifies
for both; the room rule for the mention only; the override for neither; with both rules present the
override wins; `GET /pushrules/` lists them. Continuwuity leaves a rule kind out of that response
when it's empty, so readers must treat a missing `room` or `override` list as empty.

## Spaces

Matrix has no Space-level push rules, and none that could say "every room in this Space". A
Space's level is therefore written into each of its channels as that channel's rules, and
re-applied when a channel is added to the Space or you join one.

What you chose lives in account data (`xyz.nekous.notification_settings`), and the rules are
worked out from it:

```json
{
  "spaces": { "!space:server": "mentions" },
  "rooms":  { "!channel:server": "nothing", "!dm:server": "all" }
}
```

- A room's level is its own entry in `rooms`, else its Space's, else nothing is set here.
- A room in several Spaces with different levels gets the **loudest**: a Space you still want
  everything from shouldn't go quiet because another Space holding the same room did.
- "Use the Space's setting" on a channel removes its `rooms` entry.

### Why the settings are the source of truth, not the rules

The rules alone can't say whether a channel's "Only @mentions" was chosen for that channel or
came from its Space, and that decides what happens when the Space changes. Keeping both choices
in account data makes applying them a pure function of account data, so:

- two devices applying them at the same time end up with the same rules, whichever finishes last;
- a room this app has no setting for is never touched. A DM you set to "Mentions & keywords" in
  Element stays that way, and Purrlor's menu shows it as the current level.

The cost: for a room this app does manage (it has its own level here, or is a channel of a Space
with one), a change made in another client is put back on the next pass. Reset the channel or
Space here to stop Purrlor managing it.

### Applying

`syncNotificationRules` works out the level of every managed room, fetches the rules fresh from
the server (not the synced copy, which lags just-made writes) and makes the minimum changes:
deletes first, then adds, so a room is never briefly both muted and mentions-only. It changes
nothing when the rules already match. `NotificationRules.tsx` runs it at start, when the settings
change (from any device), when a Space's `m.space.child` state changes, and when you join a room.

When a setting is **removed** (a channel back to its Space's level, a Space back to the default),
the device making the change deletes the rules of rooms that are no longer managed. This isn't
done on every pass, because a room with no setting here may have rules from another client.

### Known limits

- A channel removed from a Space, or a room you leave, keeps its last rules until you change its
  setting. Harmless for a room you've left; a channel moved out of a Space stays at the Space's
  old level.
- "All messages" uses the server's default rules, which play no sound for group rooms. There's no
  "All messages, with sound" level.
- Keywords (Element's "Mentions & keywords") aren't offered. Content rules would work unchanged
  (they run before `room` rules), but there's no UI to add them.

## UI (to build)

The data layer above is done and tested. What's left is the menus, which only call the functions
below:

| Where | What it shows | Calls |
|---|---|---|
| Channel list, right-click or ⋯ on a channel; DM list the same | **Use Space setting (Only @mentions)** / All messages / Only @mentions / Nothing, the current one checked. Outside a Space the first option is **Default (All messages)**. | `describeRoomLevel(mx, roomId)` for the state; `setRoomNotificationLevel(mx, roomId, level \| undefined)` |
| Space header menu (the channel list's Space name) | **Default** / All messages / Only @mentions / Nothing | `readNotificationSettings(mx).spaces[spaceId]`; `setSpaceNotificationLevel(mx, spaceId, level \| undefined)` |
| Channel list rows | "Nothing" channels dimmed. "Only @mentions" channels still show as unread (bold) when they have new messages, with no count badge. | see below |

The unread styling needs one small change. `ChannelList.tsx` marks a channel unread when its
notification count is above zero, and under "Only @mentions" or "Nothing" that count stays at zero
for plain messages, so the channel would look fully read. The bold state should come from whether
there are messages newer than your read receipt (`room.getEventReadUpTo(userId)` against the latest
message from someone else); the badge keeps using the counts.

Setting a level is two or three requests (account data, then the rules), so the menu should show
the new choice straight away and log a failure rather than block on it.
