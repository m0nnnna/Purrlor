#!/usr/bin/env bash
# Tests for `purrlor backup`, `restore`, `backup schedule`, `backup copy-to` and `alerts`. A fake
# `docker` runs the real scripts purrlor hands its throwaway containers, with each container path
# swapped for a folder standing in for that volume, so what's tested is what the server runs. Fake
# `curl` and `scp` record what they're asked instead of reaching anything, and a fake `id` makes
# the script think it's root, so this runs anywhere bash does:  bash deploy/test/purrlor-backup.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
VOLS="$WORK/vols"
mkdir -p "$REPO/deploy" "$WORK/bin" "$WORK/cron.d" "$WORK/state" "$WORK/remote" "$WORK/dockerroot"
# The homeserver's DNS file is written from this machine's /etc/resolv.conf, which a test machine
# may not have (Git Bash on Windows); this copy reads a stand-in instead.
sed "s#/etc/resolv.conf#$WORK/resolv.conf#g" "$HERE/../purrlor" > "$REPO/deploy/purrlor"
echo "nameserver 192.0.2.53" > "$WORK/resolv.conf"
# Windows (Git Bash) has no file modes or real symlinks, so those few checks only run elsewhere.
POSIX_FS=yes; case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) POSIX_FS=no ;; esac

# --- fakes ---------------------------------------------------------------------------------------

cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# compose: recorded without its -f/--env-file/--profile, and `ps -a -q SERVICE` answered with a
# made-up container id that `run --volumes-from` below knows.
if [ "$1" = compose ]; then
  shift; rest=()
  while [ $# -gt 0 ]; do case "$1" in -f|--env-file|--profile) shift 2 ;; *) rest+=("$1"); shift ;; esac; done
  echo "compose ${rest[*]}" >> "$DOCKER_LOG"
  [ "${rest[0]}" != ps ] || echo "cid-${rest[${#rest[@]}-1]}"
  exit 0
fi
if [ "$1" = info ]; then echo "$WORK/dockerroot"; exit 0; fi
[ "$1" = run ] || { echo "fake docker: $*" >&2; exit 1; }
shift
cid=""; maps=(); envs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rm) shift ;;
    --volumes-from) cid="$2"; shift 2 ;;
    -v) maps+=("$2"); shift 2 ;;
    -e) envs+=("$2"); shift 2 ;;
    alpine) shift; break ;;
    *) echo "fake docker: unexpected $1" >&2; exit 1 ;;
  esac
done
echo "run $cid ${1:-}" >> "$DOCKER_LOG"
# Where each container path is on this machine: the service's own volumes, then the -v mounts.
keys=(); dirs=()
case "$cid" in
  cid-matrix) keys+=(/var/lib/continuwuity /purrlor-media); dirs+=("$VOLS/matrix-db" "$MEDIA_HOST") ;;
  cid-token-server) keys+=(/data); dirs+=("$VOLS/token-server") ;;
  cid-push-gateway) keys+=(/data); dirs+=("$VOLS/push-gateway") ;;
  *) echo "fake docker: no container '$cid'" >&2; exit 1 ;;
esac
for m in ${maps[@]+"${maps[@]}"}; do
  IFS=: read -r h c _ <<<"$m"
  keys+=("$c"); dirs+=("$h")
done
# Two passes through placeholders, so a host path that happens to contain a container path (the
# repo's backups/ folder holds "/backup") is never swapped a second time.
map() {
  local s="$1" i
  for i in "${!keys[@]}"; do s="${s//${keys[i]}/@@$i@@}"; done
  for i in "${!keys[@]}"; do s="${s//@@$i@@/${dirs[i]}}"; done
  printf '%s' "$s"
}
for e in ${envs[@]+"${envs[@]}"}; do export "${e?}"; done
if [ "$1" = sh ] && [ "$2" = -c ]; then exec sh -c "$(map "$3")"; fi
args=(); for a in "$@"; do args+=("$(map "$a")"); done
exec "${args[@]}"
FAKE

cat > "$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  http://127.0.0.1:*)
    for down in ${FAKE_DOWN:-}; do case "$url" in *":$down"*) exit 7 ;; esac; done
    exit 0 ;;
esac
printf '%s\n' "$@" > "$SENT"
[ -z "${FAKE_SEND_FAIL:-}" ] || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
exit 0
FAKE

cat > "$WORK/bin/scp" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$SCP_LOG"
[ -z "${FAKE_SCP_FAIL:-}" ] || { echo "scp: Permission denied (publickey)." >&2; exit 1; }
dest="${*: -1}"
case "$dest" in *: | */) name="$(basename "${*: -2:1}")" ;; *) name="$(basename "${dest#*:}")" ;; esac
cp "${*: -2:1}" "$WORK/remote/$name"
FAKE

# df: every disk FAKE_DISK_USE% full (default 40), whatever this machine's disks are like.
cat > "$WORK/bin/df" <<'FAKE'
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 1000 400 600 ${FAKE_DISK_USE:-40}% /"
FAKE

printf '#!/usr/bin/env bash\necho 0\n' > "$WORK/bin/id"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
chmod +x "$WORK/bin/"*

export WORK VOLS DOCKER_LOG="$WORK/docker.log" SENT="$WORK/sent" SCP_LOG="$WORK/scp.log"
export MEDIA_HOST="$VOLS/media-volume"
PASS=0
FAIL=0

run() {
  : > "$DOCKER_LOG"; rm -f "$SENT"
  OUT="$(PATH="$WORK/bin:$PATH" PURRLOR_STATE_DIR="$WORK/state" PURRLOR_CRON_D="$WORK/cron.d" \
    PURRLOR_PERIODIC="$WORK/periodic" bash "$REPO/deploy/purrlor" "$@" 2>&1 < /dev/null)"
  STATUS=$?
}

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; printf '  output: %s\n' "$OUT"; }
check() { local d="$1"; shift; if "$@"; then ok; else bad "$d"; fi; }
status_is() { [ "$STATUS" -eq "$1" ]; }
status_not0() { [ "$STATUS" -ne 0 ]; }
out_has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
has_line() { grep -qxF -- "$2" "$1"; }
file_is() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
logged() { grep -qF -- "$1" "$DOCKER_LOG"; }
in_archive() { tar -tzf "$1" | grep -qx -- "$2"; }
sent_has() { [ -f "$SENT" ] && grep -qF -- "$1" "$SENT"; }

# A server with the bundled homeserver, some uploads, and records in each service.
reset_server() {
  rm -rf "$VOLS" "$WORK/state" "$REPO/backups" "$WORK/cron.d"/* "$WORK/remote"/*
  mkdir -p "$VOLS/matrix-db/media" "$MEDIA_HOST" "$VOLS/token-server/media-cache" "$VOLS/push-gateway" "$WORK/state"
  echo "rooms v1" > "$VOLS/matrix-db/db.sst"
  echo "cat picture" > "$VOLS/matrix-db/media/abc123"
  echo "@luna:purr.example" > "$VOLS/token-server/hidden-pages.txt"
  echo '{"action":"hide"}' > "$VOLS/token-server/audit.log"
  echo "cached copy" > "$VOLS/token-server/media-cache/0f0f"
  echo '[{"at":1}]' > "$VOLS/push-gateway/reminders.json"
  printf 'COMPOSE_PROFILES=matrix\nMATRIX_SERVER_NAME=purr.example\nLIVEKIT_API_SECRET=old-secret\nHOST_IP=203.0.113.1\nPURRLOR_EDGE=true\n' > "$REPO/.env"
}

newest_backup() { ls -1t "$REPO/backups"/purrlor-*.tar.gz 2>/dev/null | head -n1; }

# --- backup --------------------------------------------------------------------------------------

reset_server
run backup
check "backup succeeds" status_is 0
B="$(newest_backup)"
check "backup writes a file in ./backups" test -f "$B"
[ "$POSIX_FS" = no ] || check "the file is private" test "$(stat -c %a "$B")" = 600
check "backup stops the homeserver, token server and push gateway together" logged "compose stop matrix token-server push-gateway"
check "backup starts them again" logged "compose start matrix token-server push-gateway"
check "no maintenance marker is left behind" test ! -e "$WORK/state/maintenance"
check "it has the settings" in_archive "$B" "./env"
check "it says what it is" in_archive "$B" "./MANIFEST"
check "it has the homeserver's data" in_archive "$B" "./matrix-db.tar.gz"
check "it has the moderation records" in_archive "$B" "./token-server/hidden-pages.txt"
check "it has the audit log" in_archive "$B" "./token-server/audit.log"
check "it has the reminders" in_archive "$B" "./push-gateway/reminders.json"
check "it leaves out the token server's media cache" bash -c "! tar -tzf '$B' | grep -q media-cache"
check "no half-written file or work folder is left" test -z "$(ls -A "$REPO/backups" | grep -v '^purrlor-.*\.tar\.gz$')"
check "it says how to restore it" out_has "sudo purrlor restore $B"
mkdir -p "$WORK/x" && tar -xzf "$B" -C "$WORK/x" ./MANIFEST
check "the manifest gives the format" has_line "$WORK/x/MANIFEST" "purrlor-backup 2"

# --- restore -------------------------------------------------------------------------------------

# Things change after the backup: a new message, an upload, a page hidden, new settings, and the
# server has moved to a new address.
echo "rooms v2" > "$VOLS/matrix-db/db.sst"
echo "new upload" > "$VOLS/matrix-db/media/def456"
echo "@sol:purr.example" >> "$VOLS/token-server/hidden-pages.txt"
echo "after" > "$VOLS/push-gateway/new.json"
printf 'COMPOSE_PROFILES=matrix\nMATRIX_SERVER_NAME=purr.example\nLIVEKIT_API_SECRET=new-secret\nHOST_IP=198.51.100.7\nPURRLOR_EDGE=true\n' > "$REPO/.env"

run restore "$B"
check "restore without --yes and no terminal refuses" status_not0
check "and changes nothing" file_is "$VOLS/matrix-db/db.sst" "rooms v2"

run restore "$B" --yes
check "restore succeeds" status_is 0
check "the homeserver's database is back" file_is "$VOLS/matrix-db/db.sst" "rooms v1"
check "uploads from before are back" file_is "$VOLS/matrix-db/media/abc123" "cat picture"
check "uploads from after are gone" test ! -e "$VOLS/matrix-db/media/def456"
check "no restore folder is left in the volume" test ! -e "$VOLS/matrix-db/.purrlor-restore"
check "moderation records are back" file_is "$VOLS/token-server/hidden-pages.txt" "@luna:purr.example"
check "reminders are back, and nothing newer stays" test ! -e "$VOLS/push-gateway/new.json"
check "the settings are the backup's" has_line "$REPO/.env" "LIVEKIT_API_SECRET=old-secret"
check "but this server's address is kept" has_line "$REPO/.env" "HOST_IP=198.51.100.7"
check "and only once" test "$(grep -c '^HOST_IP=' "$REPO/.env")" -eq 1
check "containers are made again from the restored settings" logged "compose up --no-start"
check "and started" logged "compose up -d"
check "how things were is saved first" test -n "$(ls "$REPO/backups"/purrlor-before-restore-*.tar.gz 2>/dev/null)"
check "and it says how to go back" out_has "sudo purrlor restore $REPO/backups/purrlor-before-restore-"
check "no unpacked copy of the backup is left" test -z "$(ls -A "$REPO/backups" | grep -v '\.tar\.gz$')"
check "no maintenance marker is left behind" test ! -e "$WORK/state/maintenance"
UNDO="$(ls "$REPO/backups"/purrlor-before-restore-*.tar.gz)"

# Going back to how things were with the backup the restore saved.
run restore "$UNDO" --yes
check "the before-restore backup restores too" file_is "$VOLS/matrix-db/db.sst" "rooms v2"
check "with the upload from after" file_is "$VOLS/matrix-db/media/def456" "new upload"

# Media moved to its own folder ('purrlor media move'): restored into that folder, linked from the
# database, not into Docker's storage.
reset_server
run backup
B="$(newest_backup)"
mkdir -p "$WORK/mediadisk"
export MEDIA_HOST="$WORK/mediadisk"
rm -rf "$VOLS/matrix-db/media"
ln -s "$MEDIA_HOST" "$VOLS/matrix-db/media"
echo "on the media disk" > "$MEDIA_HOST/zzz"
echo "MATRIX_MEDIA_DIR=$MEDIA_HOST" >> "$REPO/.env"
run restore "$B" --yes
check "restore with moved media succeeds" status_is 0
check "the upload lands in the media folder" file_is "$MEDIA_HOST/abc123" "cat picture"
check "what was there after the backup is gone" test ! -e "$MEDIA_HOST/zzz"
[ "$POSIX_FS" = no ] || check "the database links to the media folder" test -L "$VOLS/matrix-db/media"
check "and doesn't hold a copy" test ! -e "$VOLS/matrix-db/media.moved-away"
check "the database itself is back" file_is "$VOLS/matrix-db/db.sst" "rooms v1"
check "no restore folder is left on the media disk" test ! -e "$MEDIA_HOST/.purrlor-restore"
check "the media folder setting is this server's" has_line "$REPO/.env" "MATRIX_MEDIA_DIR=$MEDIA_HOST"
export MEDIA_HOST="$VOLS/media-volume"

# A backup from before format 2 (no MANIFEST, no service data) restores what it has and keeps the rest.
reset_server
mkdir -p "$WORK/old"
cp "$REPO/.env" "$WORK/old/env"
tar -czf "$WORK/old/matrix-db.tar.gz" -C "$VOLS/matrix-db" .
tar -czf "$WORK/old.tar.gz" -C "$WORK/old" ./env ./matrix-db.tar.gz
echo "@sol:purr.example" > "$VOLS/token-server/hidden-pages.txt"
run restore "$WORK/old.tar.gz" --yes
check "an older backup restores" status_is 0
check "it says it has no moderation records" out_has "no moderation records"
check "and this server's are kept" file_is "$VOLS/token-server/hidden-pages.txt" "@sol:purr.example"

# Refusals: nothing is stopped or changed.
echo "not a backup" > "$WORK/junk.tar.gz"
run restore "$WORK/junk.tar.gz" --yes
check "a file that isn't a backup is refused" status_not0
check "before anything is stopped" bash -c "! grep -q 'compose stop' '$DOCKER_LOG'"
mkdir -p "$WORK/newer" && cp "$REPO/.env" "$WORK/newer/env" && echo "purrlor-backup 99" > "$WORK/newer/MANIFEST"
tar -czf "$WORK/newer.tar.gz" -C "$WORK/newer" .
run restore "$WORK/newer.tar.gz" --yes
check "a backup from a newer Purrlor is refused" status_not0
check "and it says to update" out_has "purrlor update"
run restore "$WORK/nope.tar.gz" --yes
check "a missing file is refused" status_not0

# --- nightly backups -----------------------------------------------------------------------------

reset_server
run backup schedule daily 2
check "schedule daily succeeds" status_is 0
check "it writes a cron job for root at 03:30" grep -qF "30 3 * * * root $REPO/deploy/purrlor backup run-scheduled" "$WORK/cron.d/purrlor-backup"
check "it remembers how many to keep" has_line "$REPO/.env" "PURRLOR_BACKUP_KEEP=2"
run backup
MANUAL="$(newest_backup)"
for i in 1 2 3; do run backup run-scheduled; command sleep 1; done
check "the nightly run succeeds" status_is 0
check "only the newest 2 nightly backups are kept" test "$(ls "$REPO/backups"/purrlor-auto-*.tar.gz | wc -l)" -eq 2
check "a backup made by hand is never cleared out" test -f "$MANUAL"
check "a good run leaves no failure marker" test ! -e "$WORK/state/backup-failed"
run backup schedule
check "schedule on its own says they're on" out_has "Nightly backups are on"
run backup schedule daily 0
check "keeping 0 is refused" status_not0
run backup schedule off
check "schedule off removes the cron job" test ! -e "$WORK/cron.d/purrlor-backup"

# Alpine: no /etc/cron.d, so /etc/periodic/daily.
rm -rf "$WORK/cron.d"; mkdir -p "$WORK/periodic/daily" "$WORK/periodic/15min"
run backup schedule daily
check "on Alpine it goes in periodic/daily" test -x "$WORK/periodic/daily/purrlor-backup"
run backup schedule off
check "and comes out again" test ! -e "$WORK/periodic/daily/purrlor-backup"
rm -rf "$WORK/periodic"; mkdir -p "$WORK/cron.d"

# --- copying backups off the server --------------------------------------------------------------

reset_server
: > "$SCP_LOG"
FAKE_SCP_FAIL=1 run backup copy-to backup@store.example:/purrlor
check "copy-to that can't connect fails" status_not0
check "and says how to set up a key" out_has "ssh-copy-id backup@store.example"
check "and changes nothing" bash -c "! grep -q PURRLOR_BACKUP_COPY_TO '$REPO/.env'"
run backup copy-to backup@store.example:/purrlor
check "copy-to succeeds" status_is 0
check "it trusts the other server's key the first time" grep -qx "StrictHostKeyChecking=accept-new" "$SCP_LOG"
check "it's remembered" has_line "$REPO/.env" "PURRLOR_BACKUP_COPY_TO=backup@store.example:/purrlor"
check "a test file went over" test -f "$WORK/remote/purrlor-copy-test.txt"
run backup copy-to "backup@store.example:/x; rm -rf /"
check "a destination with shell characters is refused" status_not0
run backup schedule daily
run backup run-scheduled
command sleep 1   # backups are named to the second
check "the nightly backup is copied over" test -n "$(ls "$WORK/remote"/purrlor-auto-*.tar.gz 2>/dev/null)"
check "into the folder given" grep -qx "backup@store.example:/purrlor/" "$SCP_LOG"
FAKE_SCP_FAIL=1 run backup run-scheduled
check "a failed copy still keeps the backup here" test "$(ls "$REPO/backups"/purrlor-auto-*.tar.gz | wc -l)" -eq 2
check "and leaves a marker for alerts" test -f "$WORK/state/backup-copy-failed"
run backup copy-to off
check "copy-to off forgets it" has_line "$REPO/.env" "PURRLOR_BACKUP_COPY_TO="

# --- alerts --------------------------------------------------------------------------------------

reset_server
FAKE_SEND_FAIL=1 run alerts https://ntfy.sh/purrlor-test
check "alerts to somewhere unreachable fails" status_not0
check "and changes nothing" test ! -e "$WORK/cron.d/purrlor-alerts"
run alerts https://ntfy.sh/purrlor-test
check "alerts on succeeds" status_is 0
check "it sends a first message" sent_has "will send alerts here"
check "ntfy gets plain text" sent_has "Content-Type: text/plain; charset=utf-8"
check "it checks every 5 minutes" grep -qF "*/5 * * * * root $REPO/deploy/purrlor alerts check" "$WORK/cron.d/purrlor-alerts"

run alerts check
check "nothing wrong: nothing sent" test ! -e "$SENT"
FAKE_DOWN=3001 run alerts check
check "the token server down is reported" sent_has "the token server isn't answering"
FAKE_DOWN=3001 run alerts check
check "and only once" test ! -e "$SENT"
run alerts check
check "and when it's back, that's said too" sent_has "Fine again"
FAKE_DISK_USE=93 run alerts check
check "a disk over 90% full is reported" sent_has "is 93% full"
check "each disk once" test "$(grep -o '93% full' "$SENT" | wc -l)" -eq 1
run alerts check
touch "$WORK/state/maintenance"
FAKE_DOWN=8008 run alerts check
check "nothing is down while a backup has it stopped" test ! -e "$SENT"
rm -f "$WORK/state/maintenance"

run backup schedule daily
echo "last night's backup failed (test)" > "$WORK/state/backup-failed"
run alerts check
check "a failed nightly backup is reported" sent_has "last night's backup failed"
rm -f "$WORK/state/backup-failed"

FAKE_DOWN=8080 FAKE_SEND_FAIL=1 run alerts check
FAKE_DOWN=8080 run alerts check
check "an alert that couldn't be sent is tried again" sent_has "the web app isn't answering"

run alerts https://discord.com/api/webhooks/1/abc
check "Discord gets JSON" sent_has '"username":"purrlor"'
FAKE_DOWN="8080 3002" run alerts check
check "several problems go in one message, each on its own line" sent_has '\n- the web app'
run alerts https://hooks.slack.com/services/T/B/x
check "Slack gets its own shape" sent_has '{"text":"'
run alerts "https://example.com/a b"
check "a URL with a space is refused" status_not0
run alerts off
check "alerts off removes the check" test ! -e "$WORK/cron.d/purrlor-alerts"

# --- help ----------------------------------------------------------------------------------------

run help
for word in "purrlor restore" "purrlor backup schedule" "purrlor backup copy-to" "purrlor alerts"; do
  check "help mentions '$word'" out_has "$word"
done

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
