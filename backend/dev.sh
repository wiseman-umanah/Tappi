#!/usr/bin/env bash
# Runs the whole backend locally: Postgres (Docker), the engine, then the API. Ctrl-C stops both.
#   ./dev.sh            API on http://127.0.0.1:8080 (docs: /docs), reachable from your phone on Wi-Fi
# Needs engine/.env and api/.env (copy the .env.example files; ENGINE_TOKEN must match in both).
set -euo pipefail
cd "$(dirname "$0")"

for f in engine/.env api/.env; do
  [ -f "$f" ] || { echo "Missing $f: copy ${f}.example and fill it in."; exit 1; }
done

echo "→ Postgres"
docker compose up -d db --wait >/dev/null
# The first start initialises the database, then restarts it: wait for the real thing.
until docker compose exec -T db psql -U tappi -d tappi -tAc 'select 1' >/dev/null 2>&1; do sleep 1; done

ENGINE=""; API=""
# Whatever happens below (a failed migration, Ctrl-C), stop what was started.
trap 'echo; echo "stopping"; kill $ENGINE $API 2>/dev/null; wait 2>/dev/null' EXIT INT TERM

echo "→ engine (building if needed)"
(cd engine && cargo build -q)
(cd engine && set -a && . ./.env && set +a && exec ./target/debug/tappi-engine) &
ENGINE=$!

echo "→ API migrations"
(cd api && uv run -q alembic upgrade head)

echo "→ API"
(cd api && exec uv run -q tappi-api) &
API=$!

until curl -sf http://127.0.0.1:8080/api/health >/dev/null 2>&1; do
  kill -0 $ENGINE 2>/dev/null || { echo "the engine stopped: see its log above"; exit 1; }
  kill -0 $API 2>/dev/null || { echo "the API stopped: see its log above"; exit 1; }
  sleep 1
done
LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || true)
echo
echo "Ready."
echo "  API docs:   http://127.0.0.1:8080/docs"
[ -n "$LAN" ] && echo "  From phone: http://$LAN:8080 (same Wi-Fi)"
echo "  Ctrl-C to stop."
wait
