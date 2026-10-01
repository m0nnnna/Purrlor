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

## Month view, exporting, and announcing

- **Month view.** Events has a List / Month switch. The month is a grid of whole weeks (starting on
  your locale's first day); an event sits on the day it starts, and a day you pick shows its events'
  cards beneath. It reads every event, past ones included (`matrix/calendarMonth.ts`).
- **.ics.** Each event has **Add to calendar**, and the header **Export** downloads every upcoming
  event, as an iCalendar file (`matrix/calendarExport.ts`) for Google Calendar, Apple Calendar,
  Outlook and the like. It's a file to import, not a subscription: a subscription would need a
  public URL serving events that are private to the Space. An event held in a channel gets the
  channel as its location; one with no end is an hour, as the calendar counts it.
- **Announcing.** Creating an event can post a notice in a channel (`matrix/calendarNotice.ts`): the
  event's channel by default, any channel, or none. It's an `m.notice`, like a bot's, so nobody is
  pinged. If the notice fails the event is still made. Editing an event announces nothing.

## Watch parties

A watch party is a calendar event that also says what to play, in one of the Space's voice channels
(`matrix/watchParty.ts`). It adds a field and reuses what was already there:

```json
// on xyz.nekous.calendar_event, only with a channel_id
{ "watch": { "url": "https://youtu.be/…", "mode": "watch" } }   // mode: "watch" or "listen"
```

Older clients ignore it and see a normal event. The event form has a **Watch party** toggle once a
voice channel is chosen.

- **Start ping.** Everyone who RSVP'd Going gets the event reminder (15 minutes before) and a second
  one at the start, whose **Join** button opens the voice channel and joins the call. With the push
  gateway the second reminder goes out as Web Push (`event-start:<id>`) and opens the channel.
- **Countdown.** The notice the event posts in its channel carries the event's ID
  (`xyz.nekous.calendar_event_id`), so it shows "Starts in 12m 5s", then "Live now: 4 watching" from
  the voice channel's participant list, with a Join button.
- **Starting playback.** There's no server in a call, so whoever is in the channel while the party
  is live and nothing is playing gets **Start watching** (or **Start listening**). It starts Watch
  Together with the event's link, and the banner goes away for everyone in the call.
- **Two starts at once.** Watch Together used to let the last message received win, so two people
  pressing Start together could end up on different videos. A session now carries `startedAt`; of two
  different sessions started within 2 seconds of each other the earlier wins, and the lower user ID
  breaks a tie (`shouldAcceptState`, `features/voice/watchTogether.ts`). Updates to the session
  playing (play, pause, seek) always apply. A start more than 2 seconds later is a deliberate
  replacement and wins; a stale message from an older session is dropped. Clients from before
  `startedAt` keep the old rule.
- **Events page.** A **Watch parties** filter, a badge, and a **Join now** button while one is live.
  No video thumbnail: the Events page loads nothing from YouTube.

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
- **Managing them**: Account Settings → Reminders lists both kinds. A message reminder has Open and
  Cancel; an event you're going to has Not going, since its reminder comes from your RSVP.
- **Event reminders**: 15 minutes before an event you're going to. Nothing is stored for these;
  they're worked out from your RSVPs. Each device remembers which it has shown
  (`nekous_event_reminders_shown` in local storage). None is shown for an event more than 10
  minutes under way.

A reminder appears as a card in the corner with **Open** (the message, or the Space's Events),
and as a desktop notification when the browser allows them.
