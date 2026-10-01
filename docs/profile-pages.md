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
  - **Signed out**, the public API serves only the page, so the follow-back check can't run there.
    The signed-out Top 8 lists only friends whose own pages are public (each is fetched from
    `/api/public/pages`), and trusts the owner's list for who follows back. That's a known gap,
    accepted for now: it can show someone the owner picked by hand who doesn't follow them, but only if
    they've made their own page public. Closing it would mean the token server checking follow-back
    (it already reads every profile room's follows) and returning the checked list.
- **Guestbook** (`guestbook` block). Entries are `xyz.nekous.guestbook` events (`{ "body": "…" }`, 500
  characters, plain text) in the owner's profile room (`matrix/guestbook.ts`). Signing joins that room
  the way liking does. The owner's rules are on the block: **who** (`everyone` or `following`: people
  the owner follows), **slowmode** in seconds (0 to 3600) and **blockedWords** (up to 20). Matrix
  can't stop an event before it's sent, so, as in channels, the form follows the rules and the page
  leaves out entries that break them, and the owner's client deletes entries with a blocked word as
  it reads them. The owner removes any entry the way they remove a comment (they have power level
  100 in their own room); anyone can remove their own. To switch the guestbook off, remove the block.
  The word list is part of the page, so it's public. Signed-out visitors don't see the guestbook: it
  says "Sign in to read and sign this guestbook", and that's intended.

## Artists: galleries and commissions

Two more blocks, for artists.

- **Art gallery** (`art` block). Albums (title, description) of pieces (image, title, short
  description, up to 6 tags, a rating of **General** or **Mature**). Only an open album's pieces load,
  so art pieces have their own cap (60 across a page, 24 per album) instead of counting toward the
  20 images a page shows. Tapping a tag filters an album. **Mature** pieces are hidden from anyone
  who hasn't said they're over 18 (Account Settings → Privacy, `xyz.nekous.age_confirmation` in
  account data, `matrix/ageSetting.ts`) and blurred until clicked for those who have; signed-out
  visitors never see them, and an album that is all Mature isn't shown at all. The claim isn't
  verified (the plan's open question).
- **Commissions** (`commissions` block, `matrix/commissions.ts`). The block only marks where it goes
  and carries a heading; the rest are state events in the profile room, separate from the page so a
  queue change doesn't rewrite it: `xyz.nekous.commission_status` (open, waitlist or closed, and a
  note), `xyz.nekous.commission_prices` (types with a price as the artist writes it, a description, an
  example image and "2 of 5 open" slots) and `xyz.nekous.commission_queue` (the artist's own stages,
  and slots with a title, a stage and optionally a client). All are checked on reading like the page.
  - **A client's name** shows only if they agree. The artist picks a client for a slot; the client
    agrees with an `xyz.nekous.commission_consent` event of their own in the profile room (a message
    the artist can't write for them), and until then everyone but the artist and that client sees
    "Client". The client turns it on and off with "Show my name on this slot".
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
