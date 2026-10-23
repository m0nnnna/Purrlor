#!/usr/bin/env bash
# Tests for `purrlor update` and its channels (docs/releases.md): which commit each channel moves an
# install to, the image tag it leaves in .env, `--check`, and the first update of an install from
# before releases. The origin is a real git repository with release tags; a fake `docker` records
# what it's asked, and a fake `id` makes the script think it's root, so this runs anywhere bash and
# git do:  bash deploy/test/purrlor-update.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
exit 0
FAKE
cat > "$WORK/bin/id" <<'FAKE'
#!/usr/bin/env bash
echo 0
FAKE
# The status check after an update: everything answers.
cat > "$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$WORK/bin/docker" "$WORK/bin/id" "$WORK/bin/curl"
export DOCKER_LOG="$WORK/docker.log"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

# The origin: master with this checkout's purrlor, a commit per step, and releases v1.0.0 and v1.1.0.
ORIGIN="$WORK/origin"
git init -q -b master "$ORIGIN"
git -C "$ORIGIN" config core.autocrlf false
mkdir -p "$ORIGIN/deploy"
cp "$HERE/../purrlor" "$ORIGIN/deploy/purrlor"
commit() { echo "$1" > "$ORIGIN/step"; git -C "$ORIGIN" add -A; git -C "$ORIGIN" commit -qm "$1"; }
commit one
git -C "$ORIGIN" tag -a v1.0.0 -m "Purrlor 1.0.0"
commit two
# A tag that isn't a server release must never be picked.
git -C "$ORIGIN" tag desktop-v9.9.9
commit three
git -C "$ORIGIN" tag -a v1.1.0 -m "Purrlor 1.1.0"
git -C "$ORIGIN" tag -a v2.0.0-rc1 -m "not a release"
commit four

PASS=0
FAIL=0
REPO="$WORK/repo"

# fresh REF [ENV_LINES] -> a new install in $REPO checked out at REF (as the old install.sh did, on master).
fresh() {
  rm -rf "$REPO"
  git clone -q "$ORIGIN" "$REPO"
  git -C "$REPO" -c advice.detachedHead=false checkout -q "$1"
  printf 'PURRLOR_METRICS_TOKEN=x\n%s' "${2:-}" > "$REPO/.env"
}

run() {
  : > "$DOCKER_LOG"
  OUT="$(PATH="$WORK/bin:$PATH" bash "$REPO/deploy/purrlor" "$@" 2>&1 < /dev/null)"
  STATUS=$?
}

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; printf '  output: %s\n' "$OUT"; }
check() { local d="$1"; shift; if "$@"; then ok; else bad "$d"; fi; }
at() { [ "$(cat "$REPO/step")" = "$1" ]; }
env_is() { grep -qx "$1=$2" "$REPO/.env"; }
status_is() { [ "$STATUS" -eq "$1" ]; }
out_has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
pulled() { grep -q '^compose .* pull$' "$DOCKER_LOG"; }
never_pulled() { ! grep -q 'pull' "$DOCKER_LOG"; }

# --- stable --------------------------------------------------------------------------------------

fresh v1.0.0 'PURRLOR_CHANNEL=stable
'
run update
check "stable moves to the newest release" at three
check "stable never picks a prerelease or another app's tag" out_has "Now on Purrlor 1.1.0"
check "stable uses that release's images" env_is PURRLOR_IMAGE_TAG v1.1.0
check "stable pulls the images" pulled
check "stable update succeeds" status_is 0

run update
check "a second stable update has nothing to do" out_has "Already up to date: Purrlor 1.1.0"
check "nothing to do pulls nothing" never_pulled

# --- --check -------------------------------------------------------------------------------------

fresh v1.0.0 'PURRLOR_CHANNEL=stable
'
run update --check
check "--check says an update is waiting" out_has "1.0.0 -> 1.1.0"
check "--check exits 10 when one is" status_is 10
check "--check changes nothing" at one
check "--check pulls nothing" never_pulled
run update --edge --check
check "--edge --check looks at master" out_has "(edge)"
check "--edge --check exits 10 when master is ahead" status_is 10

# --- edge ----------------------------------------------------------------------------------------

fresh v1.0.0 'PURRLOR_CHANNEL=stable
'
run update --edge
check "edge moves to master's newest commit" at four
check "edge is remembered" env_is PURRLOR_CHANNEL edge
check "edge uses the edge images" env_is PURRLOR_IMAGE_TAG edge
check "edge reports the version after the release" out_has "Now on Purrlor 1.1.0-1-g"
check "edge is on the branch, not detached" [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = master ]

run update
check "a bare update keeps following edge" out_has "Already up to date"
check "and stays on master" at four

# Back to stable from ahead of every release: it waits for the next one rather than going back.
run update --stable
check "stable from edge doesn't go backwards" at four
check "stable from edge says it waits" out_has "moves to the next release"
check "stable from edge is remembered" env_is PURRLOR_CHANNEL stable
check "waiting pulls nothing" never_pulled

# --- an install from before releases -------------------------------------------------------------

# The old `update` did `git pull` on master and then ran the new copy's update-apply.
fresh master
run update-apply
check "the first update picks the stable channel" env_is PURRLOR_CHANNEL stable
check "it says so" out_has "stable releases now"
check "an install ahead of the release stays where it is" at four
check "it still restarts onto images that match the code" env_is PURRLOR_IMAGE_TAG edge
check "and pulls them" pulled

fresh v1.1.0
run update-apply
check "an old install exactly on the release gets its images" env_is PURRLOR_IMAGE_TAG v1.1.0
check "and pulls them too" pulled

# --- images from docker load ---------------------------------------------------------------------

fresh v1.0.0 'PURRLOR_CHANNEL=stable
PURRLOR_IMAGE_PREFIX=
PURRLOR_IMAGE_TAG=latest
'
run update
check "local images keep their tag" env_is PURRLOR_IMAGE_TAG latest

# --- channel and setup ---------------------------------------------------------------------------

fresh v1.1.0
run channel-apply
check "setup on a release checkout picks stable" env_is PURRLOR_CHANNEL stable
fresh master
run channel-apply
check "setup on master picks edge" env_is PURRLOR_CHANNEL edge
fresh master
run channel-apply stable
check "setup takes the channel install.sh was asked for" env_is PURRLOR_CHANNEL stable

fresh v1.1.0 'PURRLOR_CHANNEL=stable
'
run channel
check "channel shows the version and channel" out_has "Purrlor 1.1.0, following stable"
run channel edge
check "channel edge switches" env_is PURRLOR_CHANNEL edge
check "channel edge doesn't move the checkout" at three
run update --nightly
check "an unknown option is refused" status_is 1

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
