# Purrlor

## Roadmap and model split

The plan lives in the Claude Docs doc "Purrlor review & roadmap":
https://claude.ai/code/artifact/8f290dcd-d140-46e7-9ab5-994d822de800

Its "Work split: Sonnet vs Opus" table assigns each task a model. "start sonnet work" / "start opus work" means: read the doc first (the Model dropdowns, status and comments may have changed), then do every task assigned to that model. The "Status" and "Next: Opus session" sections at the end say where things stand.

Branches as of 2026-09-29:
- `global-emote-library`: the global emote & sticker library.
- `sonnet-work`: built on top of that, with all the Sonnet tasks except GIF search. Opus work starts here.
- `sonnet/gif`: GIF search via Klipy. On hold, do not merge. Klipy's terms forbid the server proxy, re-hosting and caching this branch does unless Klipy approves it in writing.

None of these have been tested against a live homeserver.

## Checks

In `apps/web`: `npx tsc --noEmit`, `npx eslint src --max-warnings 0`, `npx vitest run`, `npx vite build`. The services (`services/token-server`, `services/push-gateway`) each have their own lint, typecheck and test scripts.

If the repo is on a network share (Windows), git may need `-c safe.directory='*'`, and vitest and vite may fail on native rollup binaries. Run them from a local copy of `apps/web` instead (see README).
