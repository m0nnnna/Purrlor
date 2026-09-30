# Posts

How the hub's per-member post feeds work: the room shape, the custom event, how a feed is
discovered, and — the part that drives everything else — how privacy is actually enforced.
Read this before touching `apps/web/src/matrix/feed.ts`,
`apps/web/src/matrix/hooks/useSpaceFeed.ts`, or `apps/web/src/features/feed/`.

## Why not Pleroma / ActivityPub

The obvious way to add microblogging to a Matrix app is to run a fediverse server next to it.
That buys a second server to operate, a second account identity for every member to understand,
an ActivityPub inbox/outbox to secure, and a second moderation queue — to get something Matrix
already supports. Rooms, timelines, rich text, reactions, redaction, edits, uploads and
permissions are all here already. What was missing was a room *shape* and a feed *view*, not a
protocol.

## The constraint everything follows from

**Matrix has no per-event visibility.** `m.room.history_visibility` is a property of the room,
not of an event in it. So a `"private": true` field on a post in a readable room would be
decoration: the event is still in `/messages` for anyone who can read the room.

Privacy here is therefore decided by **where a post lives**, never by a field on it:

| | Where it lives | Who can read it |
|---|---|---|
| Public post | an `xyz.nekous.post` event in the author's feed room | anyone in the Space |
| Private post | the author's own account data (`xyz.nekous.private_posts`) | only the author |

Making a public post private redacts the event and writes its text back to account data;
publishing a private one does the reverse. Both orderings are deliberate (`feed.ts`): unpublish
redacts *first*, so a failure leaves the post gone rather than visible; publish sends *first*, so
a failure leaves the text still saved rather than lost. The post gets a new event ID either way,
so reactions don't survive the move — the honest outcome, since its audience changed.

## `xyz.nekous.post` — a post

```json
{
  "body": "finally got the **voice channels** working",
  "format": "org.matrix.custom.html",
  "formatted_body": "finally got the <strong>voice channels</strong> working"
}
```

A timeline event with its own type rather than an `m.room.message`, for two reasons:

- **It can be power-level gated on its own.** A feed room sets `events: { "xyz.nekous.post": 100 }`,
  so only the owner posts while everyone else keeps the default level and can still react.
  `m.room.message` can't express that — a threaded reply and a top-level post are the same event
  type, so gating one gates the other.
- **A feed room peeked from Element shows nothing**, rather than a chat log that isn't one.

The *content* is message-shaped on purpose, so `renderMessageText` and `buildMessageFormatting`
work on it completely unchanged — posts get the same emotes and inline Markdown as messages,
from the same code. **Mentions are the exception** (see "Not in this pass").

A useful consequence of the custom type: posts notify nowhere. Matrix's default push rules match
`m.room.message` and `m.room.encrypted` and nothing else, so an unknown event type produces no
notification and no unread count; `DesktopNotifications` and `MentionInboxCollector` both filter
on `m.room.message` as well. Joining one feed room per member therefore doesn't turn the hub into
a notification firehose — which it otherwise would, since those rooms are joined in bulk.

## The feed room

One per member per Space, created on their first post (`ensureFeedRoom`). Not created through
`roomCreation.ts`'s `createRoom`: a feed room isn't a channel and wants none of that function's
policy, so bending it to fit would push feed-shaped options into every channel's creation path.

| | |
|---|---|
| `m.room.join_rules` | `restricted`, allowing `m.room_membership` of the Space |
| `m.room.history_visibility` | `world_readable` for a **public** Space; `shared` (members only) for any other — see "Private Spaces" below |
| `xyz.nekous.channel_type` | `feed` |
| `xyz.nekous.feed` | `{ owner, spaceId }` |
| power levels | `events: { "xyz.nekous.post": 100 }`; `events_default` untouched; then kept in step with the Space (see "The Space's authority over feeds") |
| directory visibility | private — a feed is reached through the Space, not by searching |

The owner is power level 100 as the room's creator, so "I can delete my own posts and no ordinary
member can" needs no moderation code at all. Restricting the join rule to the Space is what
lets other members join to read and react without the owner inviting each of them by hand — the
same mechanism voice channels use (`docs/voice-architecture.md`).

## The Space's authority over feeds

A feed room isn't a Space child, and only its owner has power in it, so nothing the Space does
reaches it by itself. Left alone, that meant a member banned from a Space stayed joined to every
feed they had opened (still reading a private Space's posts, still commenting), and a Space
moderator couldn't remove an abusive post or comment.

Only the owner can change their feed room, so **the owner's client keeps each of their feeds in
line with its Space** (`matrix/feedGovernance.ts`, run by `FeedGovernance` in AppShell at start and
whenever the Space's members, power levels or visibility change):

- **Membership.** Anyone joined to the feed who isn't joined to the Space is kicked. A kick is
  enough: the restricted join rule only lets Space members back in.
- **Moderators.** Whoever can delete messages in the Space (at or above its `redact` level, plus
  its creators on room version 12) is power level 50 in the feed. That's enough to delete posts
  and comments and to kick, not enough to post (100). Every state event in the feed is raised to
  100 (`state_default` and each named type), so a moderator can't change the feed's visibility,
  join rule or feed marker. Someone who stops moderating the Space is taken back out.
- **Visibility.** History visibility follows the Space being listed or not (see "If a Space
  changes"). A failed directory lookup changes nothing, rather than flipping the feed on a blip.

**This runs only while the owner has the app open.** A ban lands in someone's feed when that owner
is next online. Until then the reading side covers it: comments from anyone the Space says has
left or been banned are hidden (`isRemovedFromSpace`). That's decided only on a definite answer,
since a member who hasn't been lazy-loaded yet isn't one who left. Likes aren't filtered; a like
count can't say whose likes it counted.

**Reporting.** Any post or comment by someone else has a Report action, which sends it to the
homeserver's admins (`POST /rooms/{roomId}/report/{eventId}`). It doesn't go to Space moderators,
who can already remove it themselves. Continuwuity refuses a report from outside the room ("You
are not in the room you are reporting", checked live), so reporting joins the feed room first,
the same way liking does. Only a Space's members can join its feeds, so only they can report there.

**Checked against Continuwuity** (room version 12, its default): the owner rewrites the feed's
power levels without listing themselves (v12 creators mustn't be listed), a moderator at 50 can
remove a post but can't post (403) or change the room's state (403), and someone kicked after
leaving the Space can't rejoin (403).

**Voice calls end with membership.** Leaving a voice channel's room (by leaving its Space, or
being kicked) hangs up the call. The LiveKit token was issued while you were a member, so nothing
else would.

## Discovery: the member event

**A member's feed room ID is published as a custom key on their own `m.room.member` event in the
Space** (`xyz.nekous.feed_room`). This is the one piece of plumbing worth understanding, because
the obvious alternatives both fail:

- **`m.space.child`** needs state permission in the Space, which ordinary members don't have —
  and handing it out is precisely the hole the voice tenancy gate closes, since a member who can
  add Space children can add a room of their own and claim voice service for it.
- **Account data** is private to its owner, so nobody else could find the feed.

Your own member event is the one piece of Space state you can always write and everyone can
always read. It's already synced, so listing every feed in the hub costs zero requests.
`nicknames.ts` leans on the same property for per-Space display names — which is also why
`publishFeedPointer` spreads the existing content rather than replacing it.

Because member-event content doesn't survive leaving and rejoining a Space, the author also keeps
their own copy in account data (`xyz.nekous.feed_rooms`), checked first, so a rejoin re-points at
the existing feed instead of silently starting a second one.

## The hub timeline

`useSpaceFeed` merges the live timelines of every feed in the Space, newest first —
`mentionInbox.ts` already merges across rooms the same way, and at hub scale sorting the union
costs nothing worth optimizing. Only posts sent by a feed's *owner* count; power levels already
prevent anyone else posting there, so that check only matters for a room whose levels were
hand-edited.

**Pagination goes wide, not deep.** Every feed is paginated together, one page each, rather than
whichever room happens to hold the oldest post — the view is sorted by timestamp, so fetching
one room at a time would let a newer post from another feed appear *below* an older one that had
already been loaded. A room with nothing older left is skipped; one that errors is skipped rather
than failing the pass. The first load also paginates (up to three passes, or until it has ten
posts) because a freshly joined room arrives with only whatever `/sync` chose to include, which
for a quiet feed can be nothing at all — without that the hub looks empty in exactly the case
where it should look fullest.

Opening the view first calls `followSpaceFeeds`, which **joins** any feed room this client isn't
in yet. (`SpaceAutoJoiner` also does this in the background, so mentions reach people; see
"Mentions".) A private Space's feed rooms can only be read by joining; for a public Space's,
joining rather than peeking is a deliberate trade: reading a `world_readable` room you
aren't in requires a peek, which is the least reliably supported corner of the client-server API.
The cost is that a member ends up joined to one room per other member — fine at hub scale,
and the reason `useSpacelessRooms` filters `feed` rooms out (without it, every member's timeline
would appear as a group chat in Direct Messages).

## Media

A post carries up to four images or videos under `xyz.nekous.attachments` (`matrix/postMedia.ts`):
JPG, PNG, GIF, WebP, WebM and MP4. How each is stored depends on where the post goes (see "Private
Spaces"): a plain `mxc://` upload for public places, an encrypted one everywhere else.

**Smaller uploads.** JPEG and PNG are re-encoded to WebP in the browser before upload (quality
0.85, longest edge capped at 2560px). The original is kept if the WebP isn't smaller or the
browser can't encode WebP. GIF, WebP, WebM and MP4 upload untouched: a canvas encodes one still
frame, so converting an animation would freeze it. The composer shows how much was saved, and
checks the server's `m.upload.size` before uploading.

Each attachment records its width and height, so the post reserves its space before the media
loads. `readAttachments` drops anything malformed (a non-`mxc` URL, an unsupported type, more than
four) rather than rendering it.

## Private Spaces

A Space that isn't public (not listed in the directory) keeps its posts, and their media, to its
members.

**The posts.** A private Space's feed rooms use history visibility `shared`: readable only by
someone who has joined the feed room, and the restricted join rule only lets members of the Space
join. Someone with an account but not in the Space can't read them and can't join them. (Checked
against Continuwuity: an outsider's `/messages` comes back empty and their join is refused with
403; a member joins and reads.) `shared` rather than `joined` means someone who joins the Space
later can still read what was posted before they arrived.

**The media.** Matrix media isn't access-controlled per room: an `mxc://` upload can be
downloaded by anyone who has its URL, with any account on a server that requires authenticated
media and with no account at all on one that doesn't. So media in a private Space's posts, and
in "Only me" posts, is **encrypted in the browser before upload**. This is the same
encrypted-attachment format and library the chat timeline uses (`browser-encrypt-attachment`).
The ciphertext is uploaded with no filename and as `application/octet-stream`. The key, IV and
hash travel inside the post (`file` instead of `url` on the attachment), and only people who can
read the post have them. Anyone else who gets the URL downloads noise.

**Public or private is decided when posting**, from the directory. The composer waits until the
directory has answered before it will post into a Space. If the lookup fails, the Space counts as
private, which is the safe direction.

**If a Space changes.** A Space can be made public or private after its feeds exist. Each author's
client brings their feed room's visibility in line as soon as it sees the change, and again at
every start (`FeedGovernance`, see "The Space's authority over feeds"). Posting checks it too.

**What this can't do for posts made earlier.** History visibility applies to events from the
moment it's set. Posts made in a private Space before this change (when every feed room was
world-readable) stay readable by anyone who has the feed room's ID, and their media stays
unencrypted at its URL. To take one back, delete it (or use "Make private"). Deleting the post
removes the only link to its media, but the file itself stays on the media server until a server
admin purges it. Matrix gives clients no way to delete an upload.

**The server admin can still read it.** Members-only rooms and encrypted media stop other users.
They don't stop whoever runs the homeserver, who can read room history (the key is inside it).
Hiding posts from the server too would mean end-to-end encrypting the feed rooms themselves.
That's a larger change: the global feed and profiles read posts over plain `/messages`, which
can't decrypt.

## Posting to Global: profile feeds

Picking **Global** as a post's destination sends it to the author's **profile feed**
(`matrix/profileFeed.ts`), created on their first global post. It's a feed room with no Space:

- **Listed in the directory** under room type `xyz.nekous.profile`, world-readable, join rule
  public. The directory listing is how the global feed finds every profile on the server.
  Discover filters that room type out (`isBrowsableEntry`), and its `feed` channel type keeps it
  out of Direct Messages.
- Its ID is also published on the author's extended profile (`xyz.nekous.profile_room`) and kept
  in their account data.
- Ownership comes from the feed marker, cross-checked against the room's creator, so a
  hand-edited marker can't claim someone else's name.

## Editing

An edit is a standard `m.replace` of the same type: an `xyz.nekous.post` whose content carries
`m.relates_to: { rel_type: "m.replace", event_id }` and the whole new content (text, formatting,
media, repost) under `m.new_content`. Because it's the post type, it's gated like posting: only the
owner (power level 100) can send one. Readers also accept an edit only from the post's own sender.

Edits are applied in the app (`applyPostEdits`) rather than left to matrix-js-sdk, because the
global feed reads unjoined feeds over plain `/messages`, where nothing aggregates them. An edit
can arrive on a different page from its post, so the global feed keeps every edit it has seen and
applies the newest to each post. Edits the server bundles into
`unsigned["m.relations"]["m.replace"]` count too. An edit event never shows as a post of its
own (`isPostEvent`). An edited post reads "(edited)". Editing changes only the text: media and an
embedded repost carry over unchanged.

A repost may copy any version of a post, so the repost check also accepts a match with one of its
author's edits.

## Reposts

A repost is an ordinary post whose content carries `xyz.nekous.repost_of`: the original's room,
event, author, origin (Global or a Space), time, text and media, **embedded whole**. Anyone who
can read the repost can read what it reposts, even if they can't read the original's room.

**The copy is checked against the original** (`matrix/repostCheck.ts`), since it's whatever the
reposter's client wrote: a hand-made event could "repost" words someone never posted, under their
name. Readers can always read the original (that's the rule below), so each card fetches it once
(`GET /rooms/{roomId}/event/{eventId}`) and compares the sender, text and media. If it matches, the
copy shows. If the original was deleted (redacted or not found), the card says the post was
removed, so deleting a post, or making it private, takes it out of every repost too. If it doesn't
match, the copy isn't shown. If the check fails for any other reason (offline, forbidden while a
private Space's feed room is still being joined), the copy shows marked "Unchecked", and it's
checked again next time.

That's why reposting only moves content **between public places** (`canRepost`): from Global or
a public Space, to Global or a public Space. Copying a post out of a private Space would hand it
to people its author never posted it for. The Repost action only appears on posts from public
places, and the dialog only offers public destinations. Reposting a bare repost (no comment)
reposts the original, so reposts are never nested.

The one exception: a post from a **private Space can be reposted within that same Space**. Its
audience is exactly the one the original already had, so nothing becomes more visible, and a
private Space still gets a Repost button. `canRepost` owns the rule and `repostTargetsFor` applies
it to the destinations offered, so a post nobody could repost anywhere shows no button at all.

## Likes and comments

Both live in the post's own feed room, related to the post (`matrix/postInteractions.ts`):

- **A like** is a plain `m.reaction` with the ❤️ key, so any Matrix client sees a heart reaction.
  Un-liking redacts it. One like per person is counted, however many reactions they sent.
- **A comment** is `xyz.nekous.comment` with an `m.reference` relation to the post. Its content
  has the same shape as a post's (text, formatting, up to four images/videos under
  `xyz.nekous.attachments`), parsed by the same `readPostContent`. It's a custom type for the same
  reasons a post is: it notifies nobody, and Element shows no chat log. **Comment media follows the
  post's privacy**: plain uploads under a public post, encrypted in the browser everywhere else.

**Reading** is one `/relations` request per post, and a server answers it for a non-member when
the feed is world-readable (checked against Continuwuity), so the global feed shows counts and
threads without joining anything. Requests are capped at six in flight across a page.

**Writing** joins the feed room first. Feed rooms keep `events_default` at its default, so once
joined anyone can like or comment; only posting is gated. Anyone can join a profile feed; a
Space's feeds only admit that Space's members, so a post from a Space you're not in shows its
likes and comments with a "Join the Space to like or comment" note instead.

**Deleting**: your own comments, or anyone's under your own post (you're power level 100 in your
feed room). A Space's moderators can remove any post or comment in that Space's feeds.

**A redacted like or comment still comes back from `/relations`**, with empty content and
`unsigned.redacted_because`. Counting only relations that still carry `m.relates_to` is what
makes un-liking actually lower the count.

**Replies.** The thread is flat, but any comment can answer another: a reply carries
`xyz.nekous.reply_to` (the comment and its author) and names that author in `m.mentions`, and
shows "Replying to …" above its text. Replying to yourself mentions nobody.

**Long threads, and a post's own page.** A timeline never renders a whole thread: opening a post's
comments there shows its newest 3, and "View all N comments" (or the post's **Open** action) goes to
the post's own page (`PostPage`, over whatever it was opened from; Back returns there, and any
other navigation closes it). The page shows the whole thread: the newest 50, then "Show earlier
comments" reveals what's loaded and "Load earlier comments" fetches older pages. Repost and delete
work there too. A card reads its likes and the newest 50 comments; counts read "50+" until the
rest is loaded, never a wrong number.

Older pages don't use `/relations` pagination, because **Continuwuity's is broken backwards**:
its `next_batch` steps back one event instead of one page (50 at a time over a 130-comment
thread returns 130–81, 129–80, 128–79… — following it read 4,099 "comments"), it caps a page at
100, and paging forwards returns nothing. Its first page is right, so that's all that's read from
`/relations`. Older relations come from the room timeline instead: `/context` gives a position
just before the oldest one loaded, then `/messages` pages backwards filtered to that event type,
keeping this post's relations and stopping at the post itself. Checked live: 130 comments on one
post, interleaved with comments on another post in the same feed, come back as 50 + 75 + 5,
exactly once each, nothing from the other post. Likes past the first 100 are read the same way,
up to 1,000 ("1000+" after that).

## Notifications

Likes and comments are silent by default: no default push rule matches a comment's custom event
type, and the server-default `.m.rule.reaction` rule mutes reactions. So each author gets their
own push rules, one pair per feed they own (`matrix/postNotifications.ts`): comments notify with
sound, likes notify quietly. User rules outrank server defaults, and each is scoped by
`room_id`, so they cover only your own feeds, not every feed you've joined to comment on.

Because they're real push rules, the homeserver applies them itself: in-app notifications and
background push both follow. `NotificationRules` (mounted in AppShell) keeps them in step with
the feeds you own and your settings (**Account Settings → Posts**), including from another device,
since both live in account data. It reads rules from the client's synced ruleset, because
Continuwuity doesn't implement listing one rule kind. The push gateway words them as "Commented on
your post: …" / "Liked your post", and clicking one opens the posts view, not the feed room as a
channel.

Checked against Continuwuity with a stand-in push gateway: with no rules, nothing is delivered; with
them, both arrive, carrying the event type and comment text; the same actions in another room,
nothing. With the real sync code, 130 comments and 2 likes on a post produced 132 deliveries.

**Replies notify the person replied to, and only them.** That needs no rule of ours: the spec's
built-in `.m.rule.is_user_mention` matches `m.mentions` on any event type, custom ones included.
Checked on Continuwuity with the real `sendComment`: of a reply to Bob and a plain comment beside
it, only the reply reached Bob's push gateway. Everyone else in the thread isn't notified, and the
post's author still hears about every comment through their own feed rule.

The wording depends on who's receiving: "Replied to your comment" for the person replied to,
"Commented on your post" for the author. In the app that's known. The push gateway can't know
whose device it's delivering to, so the web app puts the user ID in the pusher's `data`, which the
homeserver echoes back with every notification. Pushers registered before that fall back to the
`highlight` tweak, which only the mention rule sets; re-enabling background push upgrades them.

**Joining needs a server to join through.** From room version 12 (Continuwuity's default) a room
ID has no `:server` part, so `via` comes from the feed owner's user ID (`feedJoinVia`); deriving
it from the room ID alone sends an empty `via`, which the server rejects.

## Mentions

Posts and comments use the chat composer's `@name` autocomplete (`useMentionAutocomplete`). Only a
name picked from the dropdown becomes a real mention, sent as `m.mentions.user_ids`. The spec's
`.m.rule.is_user_mention` matches that on any event type, so the person is notified, in the app
and by background push ("Mentioned you in a post / in a comment").

**Only people joined to the feed room can be reached.** The homeserver delivers a room's events,
and so its notifications, only to the room's members. That decides how each kind reaches people:

- **A Space post** offers the Space's members. Every client joins its Spaces' feed rooms in the
  background (`SpaceAutoJoiner`: shortly after start, on joining a Space, and whenever a member
  publishes a feed), so they're there to receive it, not only once they've opened the Posts page.
- **A comment** offers the feed room's joined members: the people who can be reached there.
- **A Global post** offers everyone the client knows of. They usually aren't in your profile
  room, so after the post goes out, its author **invites** each mentioned person who isn't
  (`matrix/mentionInvites.ts`), with a reason naming the post:
  `Mentioned you in a post (xyz.nekous.mention $eventId)`. An invite notifies by default
  (`.m.rule.invite_for_me`), and the push gateway words this one "Mentioned you in a post". The
  invitee's app accepts it by itself (`MentionInviteAcceptor`), files it in the Mention Inbox, and
  keeps it out of the Invites list. It only treats an invite that way when it's to a profile room
  (the room type, from `invite_state`), comes from that room's creator, and carries the reason.
  Anything else stays an ordinary invite. Checked on Continuwuity: `invite_state` carries both
  the room type and the reason, and the invitee joins and reads the post.

**The Mention Inbox** collects mentions in posts and comments as well as chat, as they arrive.
Opening one opens that post's page (`useOpenPost`, which fetches the post with its latest edit)
rather than a channel. So does clicking a desktop notification about a post, a comment or a like.

## The global feed

`useGlobalFeed` (logic in `matrix/globalFeed.ts`) reads posts from every place it can, **without
joining anything**, and the view picks a timeline:

- **Everyone**: public places only. That means every profile feed, plus every public Space
  (listed in the directory: Space Settings → Visibility → "Public space"), including Spaces you've never joined.
- **Following**: people and whole Spaces you follow. Follows live in your account data
  (`xyz.nekous.follows`), so nobody else can see them and nobody is notified. Following can
  include a Space you're a member of that isn't public; you can already read it, and its posts
  never reach Everyone.
- **Profiles** (`ProfileView`): one person's posts from everywhere you can read. Opened from any
  author's name, or "View posts" on a member's profile card.

**What "public" means.** For a Space, being listed in the directory. The join rule isn't used,
because an invite link also makes a Space "anyone can join", and a Space kept unlisted on
purpose must never show up on a global surface.

That distinction used to be invisible: "Public join link" said "see General settings" for
listing, but no setting existed after creation. So a Space made joinable by link looked public
and wasn't, and had no Repost button. **Space Settings → Visibility → "Public space — listed in
Discover"** now shows the server's actual answer and changes it (`matrix/spaceDirectory.ts`).
Listing sets what creating a public Space sets: listed, `world_readable`, and open to join.
Unlisting takes it out of the directory and back to members-only history, and leaves the join
link alone.

Your own Spaces are checked one by one (`GET /directory/list/room/{roomId}`, a definite answer),
not by scanning the directory, which is paged and capped and can miss a listed Space on a busy
server. The directory scan still finds public Spaces you aren't in.

**Reading without joining.** Public posts come from `/messages` on world-readable feed rooms
(a private Space's feeds are members-only, so for Spaces you're in they're joined first). Finding
the feeds in a Space you aren't in needs its `/state`, which the server only allows a non-member
to read if the Space is world-readable. Public Spaces created from now on are
(`roomCreation.ts`). That exposes the Space's name, topic, member list and feed pointers, never
chat. An older public Space that isn't world-readable is skipped and counted.

**Caps.** 40 public Spaces, 100 profiles, 200 feeds, 6 requests in flight. The caps follow
directory order, not activity, so on a bigger server Everyone is a sample, and it says so
("global-feed-truncated"). **People and Spaces you follow are never cut**: they're read directly
(a person's profile feed from `xyz.nekous.profile_room` on their extended profile, a Space by
checking it's listed and reading its `/state`) and put first, ahead of the 200-feed cut. A profile
page does the same for the person it shows. Following someone mid-session adds just their feeds. Pagination goes wide,
like the hub timeline: every feed with older history is paged together. Joined feed rooms update
live; the rest are a snapshot with a Refresh button.

## New posts

A Space's **Posts** row gets an unread dot when someone else has posted since you last had the
page open (`matrix/postsSeen.ts`). Posts don't count as unread in Matrix's sense (they notify
nobody), so this is the app's own: the newest post by another member across the Space's feed
rooms, compared with when you last looked. That time is kept per Space in account data
(`xyz.nekous.posts_seen`), so opening Posts on one device clears the dot on the others. A Space
you've never opened Posts in counts from the start of the session, so every Space doesn't light up
at once for posts that were always there. It relies on the background feed joining (see
"Mentions"): the posts are already synced, so it costs no requests.

## UI

- `features/feed/FeedView.tsx` — the whole surface: composer with an "Only me" toggle, an
  Everyone/Yours tab pair, and the post cards. Reached from the pinned **Posts** row at the top
  of a Space's channel list, which sets `selectedSpaceViewAtom` rather than
  `selectedRoomIdAtom` — the feed is a merge across rooms, not one of them, so it can't be
  expressed as a selected room. Selecting any channel clears it.
- Private posts are re-read on this view's own actions rather than through a hook: account data
  has no live-update hook in this codebase, and a private post only ever changes in response to
  something done right here.

## Not in this pass

- **Nested threads.** Replies are shown flat, labelled with who they answer, rather than indented
  under the comment.
- **Moderation when the owner is away.** A ban reaches someone's feed room only once that feed's
  owner next opens the app. Until then their comments are hidden, but the room still delivers them
  to the banned person.
- **A "chosen people" privacy tier.** Public and only-me are the two tiers. A third would be a
  second, invite-only feed room per member, where the invite list *is* the audience.
