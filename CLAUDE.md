# Purrlor

## Roadmap and model split

The current plan is the Claude Docs doc "Purrlor: profile pages and what comes after":
https://claude.ai/code/artifact/160c8b88-75c8-47c1-a433-1151d29bbfda

Its "Work split" table assigns each task a model and has a Status column. "start sonnet work" / "start opus work" means: read that doc first (the Model dropdowns, checklist and open questions may have changed), then do every task assigned to that model, on a new branch off `master`. Exception: this plan's work builds on the unmerged `profile-pages` branch and, since 2026-10-01, on `sonnet-work-2` (which is `profile-pages` plus the Sonnet tasks: the parser now has the friends, guestbook, art and commissions blocks), so branch off `sonnet-work-2` instead (or commit onto it), and read `docs/profile-pages.md` and `docs/public-web.md` first: they're the contract for the client work. Since the Opus work of 2026-10-01, branch off `opus-work-2` (which is `sonnet-work-2` plus the control socket, music checks and fixes), and read `docs/admin-control.md` too: it's the contract for the `purrlor` commands.

The plan before it, "Purrlor: what's next", is done apart from its open questions:
https://claude.ai/code/artifact/277fec85-bdab-431f-bcf6-cbdf368db48b

The earlier plan, and the record of everything built before that, is "Purrlor review & roadmap":
https://claude.ai/code/artifact/8f290dcd-d140-46e7-9ab5-994d822de800

Branches as of 2026-09-30:
- `master`: everything, merged 2026-09-30 (fast-forward from `opus-work`; `global-emote-library`, `sonnet-work` and `opus-work` are now fully contained in it). The live server is small and treated as a beta, so `master` deploys straight to it.
- `profile-pages`: the profile pages plan, started 2026-10-01: phases 1 and 2 (installable app, page parser, renderer, builder) and phase 3's service side (the public web API in the token server, page reports and admin hiding). Pushed, not merged: nothing deploys until the plan is finished.
- `sonnet-work-2`: the Sonnet tasks of the profile pages plan (public web views, Top 8 and guestbook, watch parties, art galleries and commissions), off `profile-pages`, 2026-10-01. Pushed, not merged.
- `opus-work-2`: the Opus tasks of the profile pages plan's "Next" and admin tables (control socket, takedown and report plumbing, music block checks and the media route, the staging run, the review of the Sonnet additions, signed-out Top 8 follow-back) and the follow-publishing fix, off `sonnet-work-2`, 2026-10-01. Pushed, not merged. Sonnet's `purrlor` commands build on its `docs/admin-control.md`, so the next Sonnet work branches off this one.
- `sonnet/gif`: GIF search via Klipy. On hold, do not merge. Klipy's terms forbid the server proxy, re-hosting and caching this branch does unless Klipy approves it in writing.

## Checks

In `apps/web`: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npx vite build`, and the end-to-end tests: `npm run e2e:homeserver` (Docker), then `npm run e2e` (see `apps/web/e2e/README.md`). The services (`services/token-server`, `services/push-gateway`) each have their own lint, typecheck and test scripts.

If the repo is on a network share (Windows), git may need `-c safe.directory='*'`, and vitest and vite may fail on native rollup binaries. Run them from a local copy of `apps/web` instead (see README).
