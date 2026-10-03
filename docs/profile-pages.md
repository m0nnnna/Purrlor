# Profile pages

Everyone can build a **page** on their profile: colours, a background, fonts, an effect, and a
set of blocks (text, link buttons, images, a gallery, music, Spaces, dividers…) in columns beside your posts, and a profile song. It's
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
- Your name, avatar, banner, bio and real Matrix ID always go across the top, and your posts always
  down the middle. A page can restyle them but not move or hide them.
- **The layout** (`ProfilePageLayout.tsx`): your blocks sit in two columns, one either side of the
  posts. Each block is in the column you put it in (`side`, "left" or "right"); the builder lists
  the two columns, with an "Add a block" under each and a button on each block to move it across.
  Where there isn't room for three columns (a phone, a narrow window, under 980px of page) it's one:
  the left blocks, then the right ones, then the posts.
- **Every block is a module that starts closed** to its title (its own, or the kind's: About,
  Links, Gallery, Top 8…), so a page is the header and two short lists of titles beside the posts.
  A visitor opens what they want, and what they opened stays open while they're in the app. Nothing
  inside a closed module loads. A link to something in one (an album, a piece, a commission type)
  opens that module. Dividers stay plain lines between modules.
- **The profile song** isn't a block in a column: it plays in a small floating window in the corner
  of the profile (`FloatingSong.tsx`), once the visitor presses play. A page has one.
- On someone else's page, **Copy style** puts their colours, background, fonts and effect into your
  own draft, keeping your blocks.

## Storage

```json
// xyz.nekous.profile_page, state key "", in the owner's profile room
{ "version": 1,
  "style": { "colors": { "bg": "#0b0a1f", "text": "#eef0ff", "accent": "#b8a6ff", "link": "#ffd479", "block": "#16143a" },
             "background": { "kind": "gradient", "from": "#1d1450", "to": "#05040f", "angle": 170 },
             "fonts": { "heading": "handwriting", "body": "rounded" }, "corners": 18, "border": "glow",
             "borderColor": "#7c6cff", "blockOpacity": 85, "columns": 1, "effect": "stars" },
  "blocks": [ { "id": "hello", "type": "text", "side": "left", "title": "Hi", "body": "…", "formatted": "…" },
              { "id": "links", "type": "links", "side": "right", "items": [ { "label": "My art", "url": "https://…", "emote": "mxc://…", "color": "#3a2a7a" } ] } ] }
```

- The **profile room** (`matrix/profileFeed.ts`) is world-readable, and only its owner can set its
  state. Publishing creates it if you've never posted globally.
- Empty content (`{}`) means no page; that's what **Take page down** writes.
- The **draft** is account data, `xyz.nekous.profile_page_draft` (`{ "page": …, "updated_ts": … }`),
  so it follows you between devices and nobody else sees it.
- `side` is the column a block sits in. A block saved before there were columns (or with a side
  the app doesn't know) goes where its kind does: gallery, music, Top 8, guestbook and commissions
  on the right, everything else on the left. The profile song has no side, and only the first song
  block on a page is kept. `style.columns`, from when blocks could be laid out in two columns
  above the posts, is still read and kept but no longer drawn.
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

## Galleries and commissions

A gallery for anyone, and a commissions block for artists.

- **Gallery** (`gallery` block): the one block for pictures. Albums (title, description) of pieces
  (image, title, caption, up to 6 tags). On the page each album is a strip of its first four
  pieces as small squares and "View all (n)", which opens the whole album over the page, where
  tapping a tag filters it. Only those small thumbnails load until an album is opened, so pieces
  have their own cap (60 across a page, 24 per album, 12 albums) instead of counting toward the 20
  images a page shows. `ratings` is an option on the block (the builder's "Let me rate pieces as Mature"): on, each
  piece is **General** or **Mature**; off, every piece is General. **Mature** pieces are blurred
  until clicked for signed-in people. There's no age setting: every account is 18+ (section 1 of the
  terms), and 18+ content must carry a content warning. Signed-out visitors never see them (the
  public API leaves them out of the page and the media route won't serve them), and an album that is
  all Mature isn't shown to them at all. Older pages still read: a flat gallery (`images`) is one
  album, and an `art` block is a gallery with ratings on. The builder saves the new shape.
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
| Numbers | clamped: corners 0–32 px, see-through 0–70%, gradient angle 0–359°. Whole numbers only in the published event (a homeserver refuses fractions), so `blockOpacity` is stored as a percentage, 30–100; a page published as a fraction (0.3–1) before that still reads |
| Text | labels and titles one line; text blocks up to 2,000 characters |
| Blocks | known types only, at most 40, IDs `[A-Za-z0-9_-]` and unique |
| Images per page | 20 in all (the background counts); gallery pieces are separate, 60 per page |
| Music tracks | `mxc://` files of an allowed sound type, 20 per page in all, title and artist one line each (100 characters) |

Unknown fields and block types are dropped, not passed through. The renderer
(`features/profilePage/pageStyle.ts`) sets the checked values as `--page-*` custom properties on
the page's own container; `ProfilePage.css` does the styling. No value a person typed becomes a
selector, a property name or a `url()`: the background's `url()` is the homeserver URL the app
builds itself from a checked `mxc://` URL.

## Safety

- **Links** open in a new tab with `rel="noopener noreferrer nofollow ugc"`, and every link shows
  the site's domain under its label.
- **The profile song** (the floating window) loads nothing until the visitor presses play: no autoplay, and no request
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
{ "id": "m1", "type": "music", "title": "Releases",
  "albums": [ { "id": "lp", "title": "Night Drive", "year": 2024, "description": "Recorded at home",
                "cover": "mxc://…",
                "tracks": [ { "url": "mxc://…", "mimetype": "audio/mpeg", "title": "Moonlight",
                              "artist": "Luna", "duration": 201, "size": 4800000 } ] } ] }
```

A music block is albums of tracks. An album has an ID, and optionally a title (one line, 60
characters), a `year` (a whole year, 1900 to 2100), a one-line `description` (200 characters) and a
`cover` (an `mxc://` page image, shown as a small square thumbnail). The older music block, a flat
`tracks` list with no `albums`, reads as a single untitled album (ID `a0`); the builder saves the new
shape. Album IDs are made unique, as block IDs are.

`parseProfilePage` keeps a track only with an `mxc://` file, a `mimetype` from `MUSIC_AUDIO_TYPES`
(MP3, AAC/M4A, Ogg, Opus, WebM, FLAC, WAV; lower-cased, parameters dropped) and a title. Title and
artist are one line each, at most 100 characters. `duration` (seconds, up to six hours) and `size`
(bytes) are what the uploader measured, for the track list only; a nonsense value is dropped and the
track kept. An album holds 30 tracks; a page holds 100 tracks and 20 albums in all, across its music
blocks. Tracks and covers don't count toward the 20 images. An album with no usable track is dropped,
and so is a music block with no album left.

The public media route serves a track only while the page is public (above) and only with one of
those sound types, refuses files over its size limit, and answers range requests, so a player can
seek (`docs/public-web.md`). It serves an album's cover on the same terms as the page's other images.

**In the builder** ("Add a block" → Music; `BlockEditor.tsx`, `AudioPicker.tsx`,
`matrix/musicTracks.ts`): a new music block starts with one album. Each album has its title, year,
description and cover, "Add tracks…", and buttons to move it up or down or remove it; "Add an album"
adds another. "Add tracks…" uploads each file as is (plain, since the page is public) into that album
and fills in the track: the type (from the file, or its extension when the browser reports none or a
variant like `audio/mp3`; a file declared as anything but sound is refused), its length (read from the
file's header), its size, and a title from the file name. Files over the smaller of the homeserver's
upload limit and the public route's 100 MiB are refused with a message, since they would never play for
signed-out visitors. Title and artist can be edited, tracks reordered or removed, and, with more than
one album, moved to another album from the track's Album menu (a full album can't take more). An
album left with no tracks isn't kept on publishing. The builder reminds people to upload only music
they have the right to share.

**On the page** (`MusicBlock.tsx`): a shelf of album cards, cover and title (with the year, number
of tracks and total length), however many albums there are, so a long discography doesn't push the
posts down. Pressing a card opens the album over the page: its cover and details, "Play album", "Copy
link", and the track list, each track with its own link button. The card of the album playing says
so.

**The player** (`features/music/`): one for the whole app, so music keeps playing when you close the
album, go to another profile, a channel or the feed. `MusicPlayerHost` holds the only audio element,
mounted once in the app shell (signed in) and in the public frame (signed out); `MusicPlayerBar` is
its controls: what's on and from which album, back (or to the start of the track, a few seconds in),
play or pause, next, seek, volume (the same remembered volume as Listen Together) and close, which
stops it. Signed in, the controls are a card in the sidebar above your name, beside Listen
Together's; on a phone, where the sidebar is out of sight on the chat screen, a strip across the top
(the shell moves down to make room). Signed out, a bar along the bottom of the page. There's no audio
element until something is played, so a page of music costs no requests beyond the covers'
thumbnails. Signed out, a track plays from the public media route; signed in, from the homeserver
like any other page file. A track that ends goes on to the next in its album, and the album stops
after its last. Links between signed-out pages are ordinary page loads, so there the music stops
when the visitor follows one.

### Links to a page and the things on it

**Share** on a profile (yours or anyone's) gives its address, `https://<app>/@name`: the phone's
share sheet on a touch screen, otherwise copied. Your own profile says, until you show your page to
everyone, that only people signed in can open it. Things on a page have addresses of their own
(`matrix/publicWeb.ts`'s `pageTargetPath`; numbers count from 1):

| Address | Opens |
| --- | --- |
| `/@name/music/<album>` | the page with that album's songs open (and its module) |
| `/@name/music/<album>/<n>` | the same, track n marked (not played: a browser won't play sound before the visitor presses something) |
| `/@name/art/<album>` | the page with that gallery album open over it (and its module) |
| `/@name/art/<album>/<n>` | the same, piece n shown large (unless it's Mature) |
| `/@name/commissions/<type>` | the page scrolled to that commission type, marked, its example shown large |

The album dialog has "Copy link" and a link button per track; a gallery album and each piece have
one, and so does each commission type. Signed in, the address opens inside the app
(`useOpenPublicRoute` hands the target to the profile through `pageTargetAtom`); signed out, the
public page opens it (`PageTargetContext`). Commissions stay signed-in only (above), so signed out a
commission link shows the page with "Sign in to see commission status, prices and the queue".
