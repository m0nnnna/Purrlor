# Purrlor

## Roadmap and model split

The plan lives in the Claude Docs doc "Purrlor review & roadmap":
https://claude.ai/code/artifact/8f290dcd-d140-46e7-9ab5-994d822de800

Its "Work split: Sonnet vs Opus" table assigns each task a model. "start sonnet work" / "start opus work" means: read the doc first (the Model dropdowns, status and comments may have changed), then do every task assigned to that model. The "Status" and "Next: Opus session" sections at the end say where things stand.

Branches as of 2026-09-30:
- `global-emote-library`: the global emote & sticker library.
- `sonnet-work`: built on top of that, with all the Sonnet tasks except GIF search.
- `opus-work`: built on `sonnet-work`, with all the Opus tasks (see the doc's "Status: Opus work done"). The latest branch; not pushed.
- `sonnet/gif`: GIF search via Klipy. On hold, do not merge. Klipy's terms forbid the server proxy, re-hosting and caching this branch does unless Klipy approves it in writing.

`opus-work` was tested against a local Continuwuity (the end-to-end suite in `apps/web/e2e/`); none has been tried on a real deployment.

## Checks

In `apps/web`: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npx vite build`, and the end-to-end tests: `npm run e2e:homeserver` (Docker), then `npm run e2e` (see `apps/web/e2e/README.md`). The services (`services/token-server`, `services/push-gateway`) each have their own lint, typecheck and test scripts.

If the repo is on a network share (Windows), git may need `-c safe.directory='*'`, and vitest and vite may fail on native rollup binaries. Run them from a local copy of `apps/web` instead (see README).
