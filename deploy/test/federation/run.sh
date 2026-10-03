#!/usr/bin/env bash
# Two federating Purrlor instances on this machine (docker-compose.yml), the federation scenario
# against them (scenario.mjs), then the homeserver checks (deploy/federation-check.mjs). Needs
# Docker and Node 18+. KEEP=1 leaves the instances running afterwards; otherwise they're removed.
#
#   bash deploy/test/federation/run.sh
set -euo pipefail
cd "$(dirname "$0")"
compose() { docker compose -f docker-compose.yml "$@"; }

if [ "${KEEP:-}" != 1 ]; then trap 'compose down -v >/dev/null 2>&1 || true' EXIT; fi

compose up -d --build --force-recreate

# Each homeserver's first account needs the one-time token it prints on its first start.
bootstrap() {
  local service="$1" port="$2" token=""
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/_matrix/client/versions" >/dev/null 2>&1 && break
    sleep 1
  done
  for _ in $(seq 1 30); do
    token="$(compose logs "$service" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'using the registration token [A-Za-z0-9]*' | awk '{print $NF}' | tail -n 1 || true)"
    [ -n "$token" ] && break
    sleep 1
  done
  [ -n "$token" ] || { compose logs "$service" >&2; echo "No bootstrap token from $service" >&2; exit 1; }
  printf '%s' "$token"
}
token_a="$(bootstrap matrix-a 6201)"
token_b="$(bootstrap matrix-b 6211)"
for port in 6202 6212; do
  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 1; done
done

status=0
node scenario.mjs "$token_a" "$token_b" || status=1

echo
echo "--- deploy/federation-check.mjs"
A_HS=http://127.0.0.1:6201 A_USER=alice A_PASS=alice-password A2_USER=a2 A2_PASS=a2-password \
B_HS=http://127.0.0.1:6211 B_USER=bob B_PASS=bob-password \
  node ../../federation-check.mjs || status=1

if [ "$status" -ne 0 ]; then
  echo
  echo "--- the token servers' logs"
  compose logs --tail 60 token-a token-b
fi
exit "$status"
