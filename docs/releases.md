# Releases and update channels

A Purrlor server follows one of two channels:

| Channel | What `purrlor update` moves to | Images |
|---|---|---|
| **stable** (the default) | the newest release tag, `vX.Y.Z` | `ghcr.io/m0nnnna/purrlor-*:vX.Y.Z` |
| **edge** | the newest commit on `master` | `ghcr.io/m0nnnna/purrlor-*:edge` |

Stable is for servers that should change only when a release says what changed. Edge is every
commit, the way every install updated before releases existed; purr.meowops.net runs it.

The desktop and Android apps have their own releases (`desktop-vX.Y.Z`, `android-vX.Y.Z`) and keep
themselves up to date; nothing here touches them.

## On a server

```bash
sudo purrlor channel            # the version this server runs, and its channel
sudo purrlor update             # the newest release (or, on edge, the newest commit)
sudo purrlor update --edge      # switch to edge and update; it sticks
sudo purrlor update --stable    # back to releases; it sticks
sudo purrlor update --check     # exit 0 = up to date, 10 = an update is waiting
sudo purrlor channel edge       # make a bare `update` follow edge, without updating now
```

The channel is `PURRLOR_CHANNEL` in `.env`. `purrlor update` sets `PURRLOR_IMAGE_TAG` to match the
checkout, so the images are always the build of the code that's checked out: the release's own
images on a release, `edge` anywhere else. (`PURRLOR_IMAGE_PREFIX=` empty, for images loaded with
`docker load`, keeps its `latest` tag.)

A stable server checks out the release tag itself (a detached HEAD, which is expected); an edge
server is on `master`. Versions are what `git describe` says: `1.0.0` on a release, `1.0.0-4-gabc1234`
four commits after it.

**Switching from edge back to stable never goes backwards.** An edge server is usually ahead of the
newest release; `update --stable` leaves it where it is and moves it at the next release.

**Right after a release** its images take about 15 minutes to build. A server that updates in that
window builds them itself (it needs ~4 GB of memory for that); waiting a few minutes avoids it.

**New installs** (`install.sh`) start on the newest release. `PURRLOR_CHANNEL=edge` in front of the
installer follows `master` instead:

```bash
curl -fsSL https://raw.githubusercontent.com/m0nnnna/Purrlor/master/install.sh | sudo PURRLOR_CHANNEL=edge sh
```

**Servers from before releases** move onto stable on their first `purrlor update`, which says so.
One that's ahead of the release (it pulled `master` after it) stays where it is until the next one;
run `sudo purrlor update --edge` to keep following every commit.

Run `sudo purrlor backup` before an update you're unsure about; `sudo purrlor restore` puts the
data back.

## Publishing a release

1. Make sure `master` is what you want to ship and CI is green on it.
2. Set the version in `VERSION` (just `1.2.0`) and write the notes in `docs/releases/v1.2.0.md`.
   Commit both and push.
3. Tag that commit and push the tag:

   ```bash
   git tag -a v1.2.0 -m "Purrlor 1.2.0"
   git push origin v1.2.0
   ```

The Images workflow (`.github/workflows/images.yml`) checks the tag matches `VERSION`, builds the
three images for amd64 and arm64 as `:v1.2.0`, `:stable` and `:latest`, and then publishes the
GitHub release with those notes. Every push to `master` meanwhile builds `:edge` and
`:sha-<commit>`.

Versions only go up. Only plain `vX.Y.Z` tags are releases: a `v2.0.0-rc1` tag is never offered to a
stable server.
