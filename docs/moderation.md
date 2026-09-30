# Report review and automod

A Space's moderators get the reports about its channels and a word filter, with nothing added on
the server. Code: `apps/web/src/matrix/reports.ts`, `matrix/automod.ts`,
`features/moderation/ModerationWatcher.tsx`, and Space Settings → **Reports**
(`features/servers/SpaceReportsSettings.tsx`). End-to-end tests: `apps/web/e2e/moderation.spec.ts`.

## The problem

The Report button used the homeserver's report endpoint, which reaches the **server's** admins
(Continuwuity posts it to its admin room) and nobody else. The people who can act on a message in
a Space, its moderators, never heard about it, and Continuwuity has no API they could read reports
through. The obvious fix, a room people report *into*, doesn't work in Matrix: there's no "can send
but can't read", so every reporter would read every other report.

## How a report travels

```
reporter's client ──to-device──▶ each Space moderator's devices
                                   │ (whichever is online first)
                                   ▼
                            the Space's review room ◀── moderators act here
```

1. **Report.** The Report action on a message (or post) still sends the homeserver report. If the
   message is in a channel of a Space with report review on, the client also sends an
   `xyz.nekous.report` **to-device message** to every device of each of the Space's moderators
   (anyone at level 50 or above in the Space). To-device messages wait for offline devices, and no
   other member ever sees them.
2. **File.** A moderator's client that receives one files it into the Space's **review room** as
   an `xyz.nekous.report` event, with the reporter taken from the to-device sender, which the
   homeserver vouches for. It checks first that it moderates that Space and that the reporter is a
   member of it. Two moderators online at once may both file the same report; it has a random
   `report_id`, and the queue shows each id once.
   **Posts and comments** in a Space's feed reach the moderators the same way. Those live in the
   member's feed room rather than a channel, so the report carries `content_kind` (`post` or
   `comment`) and `post_id` (the post it is or sits under), and the queue shows "wrote a post" and
   opens it as a post. Only a Space's own feed has moderators; a report from a member's profile
   feed goes to the server's admins only.
3. **Act.** Space Settings → Reports lists open reports: who, where, when, the reason and who
   reported it, with **Go to message**, **Delete message**, **Remove author**, **Ban author** and
   **Dismiss**. Each writes an `xyz.nekous.report_resolution` event referencing the report, and
   the report moves to "Resolved".

The review room is a moderators-only room (see [channel-permissions.md](channel-permissions.md)).
The same governance pass that runs moderators-only channels invites the Space's moderators,
accepts that invite for them, and removes anyone who stops being one. It has its own room type
(`xyz.nekous.review_room`), so room lists leave it out, and it isn't a Space child, so no one sees
it as a channel. It's created from the Reports tab ("Turn on report review") by anyone who can
change the Space's `xyz.nekous.moderation` state. Its history is `shared`, so a new moderator sees
the whole queue.

The queue only counts reports and resolutions sent by someone who is a moderator in the review
room, so someone demoted but not yet removed can't add to or change it.

### Encrypted in transit

The to-device messages are Olm-encrypted to each of the moderators' devices
(`sendEncryptedToDevice` in `reports.ts`), so the servers carrying a report can't read it.

matrix-js-sdk only encrypts to devices it tracks, which it does for members of encrypted rooms
you're in, and a reporter usually shares none with the moderators. So the reporter's client adds
the moderators to its tracked users and fetches their device keys first: the same two calls the
SDK makes when someone joins an encrypted room (`OlmMachine.updateTrackedUsers`, then processing
the outgoing key query). Those are internals of the SDK's Rust crypto, so they're checked for, not
assumed. If they're missing (an SDK that renamed them, or a client without encryption), or a
moderator has no device with keys, that moderator gets the report plain, as before, rather than
not at all.

What this doesn't change:

- The **review room** isn't encrypted, so that a moderator who joins later can read the queue.
  Once a moderator's client files a report there, the moderators' homeserver can read it.
- The **homeserver report** (the standard `/report` call, which reaches the server's admins) still
  goes too, with the reason.
- The quoted text (`excerpt`, kept in case the message is edited or deleted) is still only
  included for **unencrypted** rooms, so an encrypted channel's text never reaches the review room.

So the gain is against every *other* server a report passes through: on a federated Space, the
reporter's own homeserver and any in between see only ciphertext.

## Automod

A Space's blocked words live in its `xyz.nekous.moderation` state, edited in the same tab.
Matching is whole words or phrases, ignoring case, accents and punctuation: "cat" matches "Cat!"
but not "concatenate". There are no wildcards or patterns (punctuation in an entry reads as a
space), so a list can't make matching slow.

Matrix can't stop a message before it's sent, so enforcement has two halves:

- **In Purrlor**, the composer won't send a message containing a blocked word in that Space's
  channels, and says which word. Moderators aren't filtered.
- **From other apps**, a moderator's client that sees such a message arrive deletes it (if it may)
  and files an automod report, marked as automod and whether it was deleted. Its id is
  `automod:<event id>`, so moderators catching the same message file it once.

The second half only works while a moderator has Purrlor open. A message sent while none does
stays up until someone reports it. Automod doesn't sweep history.

## Events

| Event | Where | Content |
|---|---|---|
| `xyz.nekous.moderation` (state, key `""`) | Space | `{ "review_room": "!…", "blocked_words": ["…"] }` |
| `xyz.nekous.report` (to-device) | reporter → moderators | `report_id`, `space_id`, `room_id`, `event_id`, `reported_user`, `reason`, `reported_at`, `excerpt`? |
| `xyz.nekous.report` | review room | the same, plus `reporter`, and `automod: { word, deleted }` for automod's own |
| `xyz.nekous.report_resolution` | review room | `{ "action": "deleted" \| "removed" \| "banned" \| "dismissed", "m.relates_to": { "rel_type": "m.reference", "event_id": "<report event>" } }` |
