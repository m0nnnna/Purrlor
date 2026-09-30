# Purrlor

## Roadmap and model split

The current plan is the Claude Docs doc "Purrlor: what's next":
https://claude.ai/code/artifact/277fec85-bdab-431f-bcf6-cbdf368db48b

Its "Work split: Sonnet vs Opus" table assigns each task a model. "start sonnet work" / "start opus work" means: read that doc first (the Model dropdowns, checklist and open questions may have changed), then do every task assigned to that model, on a new branch off `master`.

The earlier plan, and the record of everything built so far, is "Purrlor review & roadmap":
https://claude.ai/code/artifact/8f290dcd-d140-46e7-9ab5-994d822de800

Branches as of 2026-09-30:
- `master`: everything, merged 2026-09-30 (fast-forward from `opus-work`; `global-emote-library`, `sonnet-work` and `opus-work` are now fully contained in it). The live server is small and treated as a beta, so `master` deploys straight to it.
- `sonnet/gif`: GIF search via Klipy. On hold, do not merge. Klipy's terms forbid the server proxy, re-hosting and caching this branch does unless Klipy approves it in writing.

## Checks

In `apps/web`: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npx vite build`, and the end-to-end tests: `npm run e2e:homeserver` (Docker), then `npm run e2e` (see `apps/web/e2e/README.md`). The services (`services/token-server`, `services/push-gateway`) each have their own lint, typecheck and test scripts.

If the repo is on a network share (Windows), git may need `-c safe.directory='*'`, and vitest and vite may fail on native rollup binaries. Run them from a local copy of `apps/web` instead (see README).
