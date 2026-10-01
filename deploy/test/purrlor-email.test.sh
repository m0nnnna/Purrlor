#!/usr/bin/env bash
# Tests for `purrlor email setup` reading back the saved mail settings, so changing the mail server
# keeps whatever isn't typed again (the password included). The prompt functions are taken out of
# deploy/purrlor and run with answers piped in; nothing is restarted.
#   bash deploy/test/purrlor-email.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Each named function's definition, one-liners included, from the real script.
extract() {
  awk -v names=" $* " '
    !inside && match($0, /^[a-z_]+\(\) *\{/) {
      name = substr($0, 1, index($0, "(") - 1)
      if (index(names, " " name " ")) { print; if ($0 !~ /\}[[:space:]]*$/ || $0 ~ /\{[[:space:]]*$/) inside = 1; next }
    }
    inside { print; if ($0 ~ /^\}/) inside = 0 }
  ' "$HERE/../purrlor"
}

{
  echo 'die() { echo "DIE: $1"; exit 1; }'
  echo 'env_get() { case "$1" in PURRLOR_HOMESERVER_URL) echo https://matrix.purr.example ;; esac; }'
  echo 'host_of() { printf "%s" "$1" | sed -E "s#^[a-z]+://##; s#[:/].*\$##"; }'
  extract urlencode urldecode email_setting email_only email_current email_prompt
} > "$WORK/lib.sh"

PASS=0
FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$3" "$2"; fi; }

# prompt ANSWERS... -> the URI and sender email_prompt builds from those answers (one per line).
prompt() {
  printf '%s\n' "$@" | EMAIL_FILE="$WORK/matrix-email.env" bash -c '. "$0"; email_prompt >/dev/null 2>&1; printf "%s\n%s\n%s\n" "$SMTP_URI" "$SMTP_SENDER" "$SMTP_MODE"' "$WORK/lib.sh"
}

save() { # save URI SENDER: what email_apply writes, as far as these functions read it
  printf "CONTINUWUITY_SMTP__CONNECTION_URI='%s'\nCONTINUWUITY_SMTP__SENDER='%s'\nCONTINUWUITY_SMTP__REQUIRE_EMAIL_FOR_TOKEN_REGISTRATION='true'\n" "$1" "$2" > "$WORK/matrix-email.env"
}

# First setup: nothing saved yet. A password with every awkward character survives the trip.
rm -f "$WORK/matrix-email.env"
out="$(prompt smtp.backup.example 587 'me@backup.example' 'p@ss:w/rd%41 &=' 'noreply@purr.example' '' 2)"
uri="$(sed -n 1p <<<"$out")"
check "first setup builds a STARTTLS URI" "$uri" "smtp://me%40backup.example:p%40ss%3Aw%2Frd%2541%20%26%3D@smtp.backup.example:587?tls=required"
check "first setup's sender" "$(sed -n 2p <<<"$out")" "Purrlor <noreply@purr.example>"

save "$uri" "Purrlor <noreply@purr.example>"
EMAIL_FILE="$WORK/matrix-email.env" bash -c '. "$0"; email_current; printf "%s|%s|%s|%s|%s|%s\n" "$CUR_HOST" "$CUR_PORT" "$CUR_USER" "$CUR_PASS" "$CUR_ADDR" "$CUR_NAME"' "$WORK/lib.sh" > "$WORK/current"
check "reads back every saved setting, the password decoded" "$(cat "$WORK/current")" "smtp.backup.example|587|me@backup.example|p@ss:w/rd%41 &=|noreply@purr.example|Purrlor"

# Pressing Enter everywhere changes nothing.
out="$(prompt '' '' '' '' '' '' '')"
check "Enter everywhere keeps the same URI" "$(sed -n 1p <<<"$out")" "$uri"
check "Enter everywhere keeps the same sender" "$(sed -n 2p <<<"$out")" "Purrlor <noreply@purr.example>"
check "Enter keeps the sign-up mode" "$(sed -n 3p <<<"$out")" "code"

# Moving to the new domain's mail server: new host and port, same login and password.
out="$(prompt smtp.meowops.example 465 '' '' 'noreply@meowops.example' 'Meowops' '')"
check "a new host on 465 is TLS, login and password kept" "$(sed -n 1p <<<"$out")" "smtps://me%40backup.example:p%40ss%3Aw%2Frd%2541%20%26%3D@smtp.meowops.example:465"
check "the new sender" "$(sed -n 2p <<<"$out")" "Meowops <noreply@meowops.example>"

# A different username asks for its own password; the old one isn't reused for it.
out="$(prompt smtp.meowops.example 587 'purrlor@meowops.example' 'newpass' '' '' '')"
check "a new username takes the new password" "$(sed -n 1p <<<"$out")" "smtp://purrlor%40meowops.example:newpass@smtp.meowops.example:587?tls=required"

# "-" drops the login, for a relay that takes none.
out="$(prompt relay.lan 25 - '' '' '')"
check "- means no username or password" "$(sed -n 1p <<<"$out")" "smtp://relay.lan:25?tls=required"

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
