# Space news

A Space can have a **News** page: a short announcement, written by whoever the Space's roles
allow, that everyone sees the first time they open the Space after it changes. Code:
`apps/web/src/matrix/spaceNews.ts` (the model), `features/news/NewsView.tsx` (the page), and the
landing in `features/channels/ChannelList.tsx`.

## Opening a Space

Picking a Space on the rail leaves nothing chosen in it, and the channel list then decides where to
go:

1. **News you haven't seen**: the News page.
2. Otherwise, the **first text channel** from the top of the channel list: channels in no category
   first, in the Space's order, then each category's in turn. Voice channels are skipped.
3. A Space with no text channels stays on its channel list.

Anything already chosen is left alone: jumping to a message from a notification, search or a
reminder, or a Space's Posts or Events.

## Who sees it, and when

The news is a state event on the Space:

```json
// xyz.nekous.space_news (state, key "")
{ "body": "Movie night is on Friday!", "revision": "mfx3k2-8a9c1d", "updated_ts": 1790000000000, "updated_by": "@nibbles:example.org" }
```

Which revision you've seen is kept per Space in your account data (`xyz.nekous.news_seen`, Space ID
→ revision), so it's the same on every device. Opening the News page counts as seeing it.

- A new member has seen nothing, so their first visit shows the news.
- Saving with **Show it to everyone again** (the default) makes a new revision, so everyone sees it
  on their next visit. Leaving it off, for a typo, keeps the revision, and nobody is shown it again.
- Whoever saves it counts as having seen it.
- Saving it empty removes the news, and with it the News row for people who can't edit.
- While there's news you haven't seen, the News row in the channel list is marked unread.

## Who can edit it

Space Settings → Roles → **Edit the Space's news** ([roles.md](roles.md)). It's the news event's own
level in the Space's power levels (default 50, moderators), so the homeserver refuses anyone below
it, whatever their client does. It isn't copied into the channels: the news lives on the Space.

The body is Markdown, rendered like a chat message (bold, italics, links, emotes), up to 10,000
characters.
