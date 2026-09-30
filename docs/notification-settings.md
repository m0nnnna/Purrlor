# Channel and Space notification settings

Per-channel, per-DM and per-Space control over what notifies you, with Discord's three choices:
**All messages**, **Only @mentions**, **Nothing**. The data layer is `apps/web/src/matrix/notificationSettings.ts`,
kept applied by `apps/web/src/features/notifications/NotificationRules.tsx`, and set from the menus
in `NotificationLevelMenu.tsx` (see "UI" below).

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

## UI

`features/notifications/NotificationLevelMenu.tsx`, reading levels through
`matrix/hooks/useNotificationLevel.ts` (re-renders on the settings, `m.push_rules` and Space
changes):

| Where | What it shows |
|---|---|
| Bell on a channel's or DM's row (on hover) | A channel in a Space: **Use Space setting (…)** / All messages / Only @mentions / Nothing. Elsewhere the first is left out and "All messages" clears the setting. The current one is checked; a level another client set shows as checked too. |
| Bell in the Space header, after the other actions | All messages (the default, clears the setting) / Only @mentions / Nothing |
| Channel rows | A quiet channel shows its level (@ or a crossed-out bell) without hovering. "Nothing" rows are dimmed and never bold. "Only @mentions" rows go bold when someone else has posted since your read receipt (`hasUnreadMessages` in `useUnreadCounts.ts`), since plain messages there don't count; the badge still shows mention counts. |

The menus don't wait for anything: the hook re-renders once the account data and rules come
back through sync, and a failure is logged to the console.

## Keywords

Account Settings → Account has **Keywords**: words that notify you wherever they're said, as if you'd
been mentioned (`matrix/keywordNotifications.ts`, `app/KeywordNotificationSettings.tsx`).

Each is a `content` push rule whose ID and `pattern` are the word, with the actions Element writes for
one (notify, the default sound, highlight). That's the same convention Element and Cinny use, so the
list is shared with them, and being push rules the homeserver applies them: unread badges, desktop
notifications and background push follow with no code of their own. The list isn't kept in account
data; it's read from the homeserver's push rules, leaving the built-in rule for your username alone.

How they mix with the levels above: rules run in the order override, content, room, so a keyword still
notifies in a channel set to **Only @mentions** (a room rule comes after it) and stays quiet in one set
to **Nothing** (an override comes before). Matching is the homeserver's: whole words, case-insensitive,
with `*` and `?` as wildcards. Up to 30, 50 characters each, no repeats.
