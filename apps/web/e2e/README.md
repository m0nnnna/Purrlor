# End-to-end tests

The production build in Chromium, against a real homeserver: a fresh Continuwuity in Docker with
federation off. Each test registers its own users and makes its own rooms through the client-server
API (`matrix.ts`), drives the app through its `data-nu-role` attributes (`app.ts`), then checks what
actually reached the server. Tests share nothing, so they run in parallel and can be rerun against
the same server.

| Spec | What it covers |
|---|---|
| `messaging.spec.ts` | Sign in, send a message another user receives, see their reply arrive, react |
| `posts.spec.ts` | Publish a post to a Space, which also creates your feed room |
| `notifications.spec.ts` | Space and channel notification levels become the right push rules and back |
| `channel-permissions.spec.ts` | Space moderators copied into channels, announcement channels (enforced by the server), moderators-only channels (members removed, hidden from the hierarchy, new moderators brought in), slowmode |
| `moderation.spec.ts` | A report reaching the Space's moderators, who delete the message from the queue; automod refusing a blocked word in Purrlor and deleting one sent from elsewhere |
| `calendar.spec.ts` | A moderator adds an event and a member RSVPs (kept in their member event), an event reminder, and a message reminder from "Remind me" to opening it |
| `encryption.spec.ts` | An encrypted room between two browsers: each reads the other, the server sees only ciphertext |

## Running locally

From `apps/web`, with Docker running:

```sh
npx playwright install chromium   # once
npm run e2e:homeserver            # a fresh server at 127.0.0.1:6167, first account created
npm run build
npm run e2e
docker compose -f e2e/docker-compose.yml down
```

`npm run e2e` starts `vite preview` on port 4173 itself (or reuses one already running). The app
is pointed at the homeserver by answering its `/config.json` request, the same file a deployment
serves. `E2E_HOMESERVER` and `E2E_REGISTRATION_TOKEN` point the tests at another server.

On Windows with the repo on a network share, run from a local copy of `apps/web`, as for the unit
tests (see the main README). `start-homeserver.sh` needs bash (Git Bash works) and curl.

When a test fails, `npx playwright show-trace test-results/<test>/trace.zip` replays it step by
step. In CI the report and traces are uploaded as the `playwright-report` artifact, and the job
prints the homeserver's log.
