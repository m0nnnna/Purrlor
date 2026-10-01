# Profile pages

Everyone can build a **page** on their profile: colours, a background, fonts, an effect, and a
stack of blocks (text, link buttons, images, a gallery, a profile song, Spaces, dividers). It's
built with a page builder, not custom CSS: every choice is a control with a fixed range, and
Purrlor draws the page with its own stylesheet. Code: `apps/web/src/matrix/profilePage.ts` (the
format and its checks), `matrix/profilePageStore.ts` (reading and writing),
`features/profilePage/` (the renderer and the builder).

The design, and what comes next (a public link for signed-out visitors, a public feed of Global
posts, guestbooks and friends), is in the doc "Purrlor: profile pages and what comes after".

## Using it

On your own profile, **Build your page** (or **Edit page** once you have one) opens the builder:
controls on the left, the page as visitors see it on the right (one at a time on a phone).

- **Start from** one of the app's looks (Nightfur, Y2K Chatroom, Lola), then change anything.
- Changes save as a **draft** as you go, so closing the builder loses nothing. Visitors see nothing
  until **Publish**.
- **Discard changes** goes back to what's published. **Take page down** returns your profile to the
  plain look and keeps what you built as a draft.
- Your name, avatar, banner, bio and real Matrix ID always sit at the top, and your posts always
  sit below the blocks. A page can restyle them but not move or hide them.
- On someone else's page, **Copy style** puts their colours, background, fonts and effect into your
  own draft, keeping your blocks.

## Storage

```json
// xyz.nekous.profile_page, state key "", in the owner's profile room
{ "version": 1,
  "style": { "colors": { "bg": "#0b0a1f", "text": "#eef0ff", "accent": "#b8a6ff", "link": "#ffd479", "block": "#16143a" },
             "background": { "kind": "gradient", "from": "#1d1450", "to": "#05040f", "angle": 170 },
             "fonts": { "heading": "handwriting", "body": "rounded" }, "corners": 18, "border": "glow",
             "borderColor": "#7c6cff", "blockOpacity": 0.85, "columns": 1, "effect": "stars" },
  "blocks": [ { "id": "hello", "type": "text", "title": "Hi", "body": "…", "formatted": "…" },
              { "id": "links", "type": "links", "items": [ { "label": "My art", "url": "https://…", "emote": "mxc://…", "color": "#3a2a7a" } ] } ] }
```

- The **profile room** (`matrix/profileFeed.ts`) is world-readable, and only its owner can set its
  state. Publishing creates it if you've never posted globally.
- Empty content (`{}`) means no page; that's what **Take page down** writes.
- The **draft** is account data, `xyz.nekous.profile_page_draft` (`{ "page": …, "updated_ts": … }`),
  so it follows you between devices and nobody else sees it.
- A text block keeps its Markdown `body` plus the `formatted` body a message would have, worked out
  from the author's emotes when the page is saved, so visitors see emotes they don't have.

## Top 8 and guestbook

Two blocks that depend on other people, so they're checked when the page is drawn, not just when it's read.

- **Top 8** (`friends` block, up to 8 people). Only people who follow the owner back are shown: a
  person's profile room publishes who they follow (`profileFeed.ts`), so `matrix/topFriends.ts`
  reads it for each name and drops anyone whose own profile doesn't list the owner. The builder
  offers only people you follow who follow you back. A page edited by hand to list someone else just
  doesn't show them.
  - **Signed out**, the token server does the check: the page it serves keeps only friends whose own
    page is public and whose profile room says they follow the owner back (`publicPageContent` in
    `services/token-server/src/publicWeb.ts`), so the answer never carries the user ID of anyone
    else. The client then draws each from its own `/api/public/pages` answer, as before.
- **Guestbook** (`guestbook` block). Entries are `xyz.nekous.guestbook` events (`{ "body": "…" }`, 500
  characters, plain text) in the owner's profile room (`matrix/guestbook.ts`). Signing joins that room
  the way liking does. The owner's rules are on the block: **who** (`everyone` or `following`: people
  the owner follows), **slowmode** in seconds (0 to 3600) and **blockedWords** (up to 20). Matrix
  can't stop an event before it's sent, so, as in channels, the form follows the rules and the page
  leaves out entries that break them (slowmode included: an entry sent sooner after the same
  person's last one than the slowmode allows isn't shown), and the owner's client deletes entries with a blocked word as
  it reads them. The owner removes any entry the way they remove a comment (they have power level
  100 in their own room); anyone can remove their own. To switch the guestbook off, remove the block.
  The word list is part of the page, so it's public. Signed-out visitors don't see the guestbook: it
  says "Sign in to read and sign this guestbook", and that's intended.

## Artists: galleries and commissions

Two more blocks, for artists.

- **Art gallery** (`art` block). Albums (title, description) of pieces (image, title, short
  description, up to 6 tags, a rating of **General** or **Mature**). Only an open album's pieces load,
  so art pieces have their own cap (60 across a page, 24 per album) instead of counting toward the
  20 images a page shows. Tapping a tag filters an album. **Mature** pieces are blurred until
  clicked for signed-in people. There's no age setting: every account is 18+ (section 1 of the
  terms), and 18+ content must carry a content warning. Signed-out visitors never see them (the public API leaves them out of the page and the media route won't
  serve them), and an album that is all Mature isn't shown to them at all.
- **Commissions** (`commissions` block, `matrix/commissions.ts`). The block only marks where it goes
  and carries a heading; the rest are state events in the profile room, separate from the page so a
  queue change doesn't rewrite it: `xyz.nekous.commission_status` (open, waitlist or closed, and a
  note), `xyz.nekous.commission_prices` (types with a price as the artist writes it, a description, an
  example image and "2 of 5 open" slots) and `xyz.nekous.commission_queue` (the artist's own stages,
  and slots with a title, a stage and optionally a client). All are checked on reading like the page.
  - **A client's name** shows only if they agree. The artist picks a client for a slot; the client
    agrees with an `xyz.nekous.commission_consent` event of their own in the profile room (a message
    the artist can't write for them, `{ "slot_id", "title", "agree" }`), and until then everyone but
    the artist and that client sees "Client". The agreement is to the slot as titled then: if the
    artist retitles it, or reuses its ID, the client is asked again. The client turns it on and off
    with "Show my name on this slot".
  - **Request a commission** sends the form (type, description, references, budget) to the artist as
    an encrypted DM, started if you've none. Purrlor takes no payments: the artist links their own
    Ko-fi or PayPal with a link button.
  - A **badge** ("Commissions: open") sits under the name on the profile when the page has the
    block. **Tell me when commissions open** is kept in your account data
    (`xyz.nekous.commission_alerts`); your client sees the status change in the artist's profile
    room (you're in it once you follow them) and shows a card and a desktop notification while a
    tab is open. There's no push for it.
  - Like every block, it's an optional add-on: nothing appears unless the owner adds the block.
    Signed-out visitors see "Sign in to see commission status, prices and the queue": the public
    API doesn't serve these events, and that's intended.

## What the checks allow

Everything that reads a page goes through `parseProfilePage`, which keeps only what it recognises.
A page written by another client, or by hand, can be odd but never more than the builder could make.

| Value | Allowed |
| --- | --- |
| Colours | `#rrggbb` only |
| Images | `mxc://` URLs whose media ID is `[A-Za-z0-9_-]` |
| Links, song | `https://` with no user name or password, at most 500 characters |
| Fonts, borders, effects, fits | names from a fixed list (`PAGE_FONTS` and the rest) |
| Numbers | clamped: corners 0–32 px, see-through 0–70%, gradient angle 0–359° |
| Text | labels and titles one line; text blocks up to 2,000 characters |
| Blocks | known types only, at most 40, IDs `[A-Za-z0-9_-]` and unique |
| Images per page | 20 in all (the background counts), 12 per gallery |
| Music tracks | `mxc://` files of an allowed sound type, 20 per page in all, title and artist one line each (100 characters) |

Unknown fields and block types are dropped, not passed through. The renderer
(`features/profilePage/pageStyle.ts`) sets the checked values as `--page-*` custom properties on
the page's own container; `ProfilePage.css` does the styling. No value a person typed becomes a
selector, a property name or a `url()`: the background's `url()` is the homeserver URL the app
builds itself from a checked `mxc://` URL.

## Safety

- **Links** open in a new tab with `rel="noopener noreferrer nofollow ugc"`, and every link shows
  the site's domain under its label.
- **The profile song** loads nothing until the visitor presses play: no autoplay, and no request
  to YouTube (`youtube-nocookie.com`, at least 200 px tall as its terms ask) or the file's host
  before then.
- **Effects** are built in; a page only names one. They're hidden for anyone whose device asks for
  reduced motion, and **Hide effects** turns them off on every page for that visitor.
- **Text blocks** go through the same renderer as messages, which builds React elements rather than
  injecting HTML.
- **Fonts** come from Google Fonts, where the app's own fonts already come from, and only the ones a
  page uses are loaded.

## Demo mode

Luna, in the global feed, has a page, so the tour shows one (`demoProfilePage` in
`demo/demoWorld.ts`).

## Music, albums and who can see them

Decided 2026-10-01 (the build is in the plan doc's "Next" table):

- **Public only with the opt-in.** A profile's albums and music are public to signed-out visitors
  only when the owner has turned on "Show my page to people who aren't signed in". The public API
  serves a page, and so the files it names, only for opted-in owners, and the media route checks the
  owner is still opted in (as of the last minute) before serving any of the page's files. With the
  switch off, signed-out visitors get nothing from the page. Signed-in people always see them. (Pictures in Global posts are a
  separate matter: those are public either way.)
- **Takedowns.** Copyright complaints go to `abuse@nekoops.net` (`TAKEDOWN_EMAIL` in
  `app/TermsOfService.tsx`, section 4 of the terms). The address has to exist before this ships.
  Admin hiding (`purrlor pages hide`) removes a whole page from the public web; a takedown blocks
  one track, an album, or everything one person made public at once, and queues the files'
  deletion from the homeserver (`docs/admin-control.md`).

### The music block

```json
{ "id": "m1", "type": "music", "title": "Demos",
  "tracks": [ { "url": "mxc://…", "mimetype": "audio/mpeg", "title": "Moonlight", "artist": "Luna",
                "duration": 201, "size": 4800000 } ] }
```

`parseProfilePage` keeps a track only with an `mxc://` file, a `mimetype` from `MUSIC_AUDIO_TYPES`
(MP3, AAC/M4A, Ogg, Opus, WebM, FLAC, WAV; lower-cased, parameters dropped) and a title. Title and
artist are one line each, at most 100 characters. `duration` (seconds, up to six hours) and `size`
(bytes) are what the uploader measured, for the track list only; a nonsense value is dropped and the
track kept. A page holds 20 tracks in all, across its music blocks; they don't count toward the 20
images. A music block with no usable tracks is dropped.

The public media route serves a track only while the page is public (above) and only with one of
those sound types, refuses files over its size limit, and answers range requests, so a player can
seek (`docs/public-web.md`). The builder doesn't offer the block yet (`BLOCKS_NOT_IN_BUILDER`): the
uploader and player are the next step.
