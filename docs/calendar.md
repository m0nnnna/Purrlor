# Calendar, events and reminders

Each Space has a calendar: moderators add events, members see what's coming up and RSVP, and
anyone going gets a reminder before it starts. Separately, any message can be set to come back as
a reminder later. Code: `apps/web/src/matrix/calendar.ts`, `matrix/reminders.ts`,
`features/calendar/`, `features/reminders/ReminderWatcher.tsx`. End-to-end tests:
`apps/web/e2e/calendar.spec.ts`.

**Per Space, not server-wide.** The roadmap left this open. A Space is where people who'd go to
the same event already are, which is also Discord's model. A server-wide calendar would need a
room of its own that every user joins, like the emote library, and could be added later without
changing how events or RSVPs are stored.

## Events

State in the Space, one per event:

```json
// xyz.nekous.calendar_event, state key = the event's id (a UUID)
{ "title": "Game night", "description": "…", "start": 1790800000000, "end": 1790807200000,
  "channel_id": "!voice:server", "location": "…" }
```

- Space state is what every member can read, and what a public Space shows to anyone, so the
  calendar needs no room of its own.
- Writing it takes the Space's state level (50, moderators, by default): members can't fill the
  calendar or change someone else's event. A Space can lower `events["xyz.nekous.calendar_event"]`
  to let everyone add events.
- Times are UTC milliseconds, shown in each viewer's local time. `end` is optional; without one an
  event counts as an hour long for "upcoming".
- An event happens either in one of the Space's channels (`channel_id`, shown as a link) or
  somewhere described in `location`.
- Cancelling sets the content to `{}`, which is how Matrix state says "gone".

## RSVPs

In each member's own `m.room.member` event in the Space, under `xyz.nekous.rsvps`:

```json
{ "membership": "join", "displayname": "Neko", "xyz.nekous.rsvps": { "<event id>": "going" } }
```

That's the one piece of Space state every member can write for themselves and nobody else can
(the trick `xyz.nekous.feed_room` already uses, see [posts.md](posts.md)). So there's no power level
to open up, and nobody can RSVP for anyone else. Writing it reads the member event fresh from the
server first, so a display-name change made a moment earlier isn't undone. RSVPs to events that no
longer exist are dropped on each write, so the member event doesn't keep growing.

RSVPs are read from the member **state events** rather than the SDK's `RoomMember` objects. When a
member event changes, the SDK emits the state change before updating those objects, so anything
reacting to the change would see the RSVP from before (the end-to-end test caught this).

## Reminders

Reminders come up in whichever Purrlor tab is open when they're due. With background push set up,
the push gateway also fires them as Web Push, so they arrive with no tab open
(docs/push-notifications.md, "Reminders"). Without it, a reminder waits for the next tab that
opens: late rather than never.

- **Message reminders**: a message's bell → In 20 minutes / 1 hour / 3 hours / Tomorrow at 9:00.
  They're kept in account data (`xyz.nekous.reminders`: `{ items: [{ id, roomId, eventId,
  remindAt, preview }] }`), so every device knows about them. The first device to show one removes
  it for all. A message in an encrypted room is saved with no preview: account data isn't
  encrypted.
- **Event reminders**: 15 minutes before an event you're going to. Nothing is stored for these;
  they're worked out from your RSVPs. Each device remembers which it has shown
  (`nekous_event_reminders_shown` in local storage). None is shown for an event more than 10
  minutes under way.

A reminder appears as a card in the corner with **Open** (the message, or the Space's Events),
and as a desktop notification when the browser allows them.
