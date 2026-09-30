#!/usr/bin/env bash
# Starts a fresh Continuwuity for the end-to-end tests (e2e/docker-compose.yml) and creates its
# first account, after which the tests can register their own with the configured token.
# Stop it with: docker compose -f e2e/docker-compose.yml down
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d --force-recreate

url="http://127.0.0.1:6167/_matrix/client/versions"
for _ in $(seq 1 60); do
  if curl -fsS "$url" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$url" > /dev/null || { docker compose logs matrix; echo "Continuwuity didn't start" >&2; exit 1; }

# Continuwuity only accepts the configured registration token once an account exists; the first
# one needs the token it prints on its first start (the same dance deploy/setup.sh does).
token=""
for _ in $(seq 1 20); do
  token="$(docker compose logs matrix 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'using the registration token [A-Za-z0-9]*' | awk '{print $NF}' | tail -n 1 || true)"
  [ -n "$token" ] && break
  sleep 1
done
[ -n "$token" ] || { docker compose logs matrix; echo "No bootstrap token in Continuwuity's log" >&2; exit 1; }

node bootstrap.mjs "$token"
echo "Homeserver ready at http://127.0.0.1:6167"
