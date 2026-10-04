# Onboarding: someone's first time

What a new account sees, and how it finds its first Space. The code is `apps/web/src/features/onboarding/`
and `apps/web/src/matrix/onboarding.ts`, `joinLinks.ts`; `e2e/onboarding.spec.ts` covers it.

## The welcome guide

Opens by itself once, for someone who hasn't seen it **and** isn't in any Space, after their recovery
key is dealt with. Four steps, each skippable; closing it at any point counts as seen:

1. **Welcome**: their display name and picture.
2. **Join a Space**: this server's public Spaces (biggest first, with a search), one click each; a
   box to paste an invite link or a Space address; or "start your own Space".
3. **Finding your way around**: what each part of the left column is.
4. **You're all set**: their profile page, background push notifications, mentions and reactions,
   and keeping the recovery key. Finishing opens the first Space they joined.

**Seen** is the account data `xyz.nekous.onboarding` (`{ "done": true, "at": <ms> }`), so it never
comes back on any of their devices. The decision waits for a sync from the server, not the copy the
app keeps from last time (`fromCache`), which comes first on a reload and can predate joining a Space
or closing the guide. Someone already in a Space (an account from before the guide existed, say)
isn't shown it. Account Settings → Account → **Getting started** opens it again.

## Joining with a link

`parseJoinTarget` reads a Purrlor invite link from any server (`?invite=<roomId>&via=<server>`), a
matrix.to link (`#/#space:server` or `#/!id?via=`, encoded or not), a bare `#space:server` or a room
ID. `joinTarget` joins plainly first and through the link's servers only if that fails (the order
`useJoinFromInviteLink` found matters), then waits for the room's state to arrive: `joinRoom` answers
before it does, and a Space opened straight away showed as a channel. Opening an invite link uses the
same join.

## Someone in no Space yet

The main pane, in place of "Nothing open yet", says they're not in any Spaces and offers the ways in:
**Find a Space** (Discover), **Start your own**, **Show me around** (the guide), and the same paste
box.

## Tests

`createUser` in `e2e/matrix.ts` marks every test account as welcomed, so the guide never opens over
another test; `createUser(prefix, { welcomed: false })` makes a brand-new one.
