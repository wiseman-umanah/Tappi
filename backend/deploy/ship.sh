#!/usr/bin/env bash
# Builds the engine and API images on this machine, uploads them to the server over SSH (no
# registry), copies the deploy files and starts the stack there. The server never compiles anything,
# so a small droplet is enough.
#
#   ./ship.sh root@203.0.113.10
#
# The server needs Docker (curl -fsSL https://get.docker.com | sh). Secrets live only in the server's
# /opt/tappi/.env: the first run puts a template there and stops so you can fill it in.
set -euo pipefail
cd "$(dirname "$0")"

SERVER=${1:?usage: ./ship.sh user@server}
DIR=/opt/tappi

echo "→ checking the server"
ssh "$SERVER" "command -v docker >/dev/null" || {
  echo "Docker isn't installed on $SERVER. Run there: curl -fsSL https://get.docker.com | sh"
  exit 1
}

echo "→ copying deploy files"
ssh "$SERVER" "mkdir -p $DIR/db-init"
scp -q compose.yml Caddyfile "$SERVER:$DIR/"
scp -q db-init/* "$SERVER:$DIR/db-init/"
if ! ssh "$SERVER" "test -f $DIR/.env"; then
  scp -q .env.example "$SERVER:$DIR/.env"
  echo
  echo "First deploy: $DIR/.env on the server is a template. Fill it in:"
  echo "  ssh $SERVER"
  echo "  nano $DIR/.env        (secrets: openssl rand -hex 32)"
  echo "Then run this script again."
  exit 1
fi

# Plain docker build: needs no secrets (compose would want the server's .env here).
echo "→ building images here"
docker build -q -t tappi-engine:latest ../engine >/dev/null
docker build -q -t tappi-api:latest ../api >/dev/null

echo "→ uploading images (compressed; the first upload takes a while)"
docker save tappi-engine:latest tappi-api:latest | gzip | ssh "$SERVER" 'gunzip | docker load' | tail -2

echo "→ starting"
ssh "$SERVER" "cd $DIR && docker compose up -d --no-build --remove-orphans && docker image prune -f >/dev/null"
DOMAIN=$(ssh "$SERVER" "grep -E '^TAPPI_DOMAIN=' $DIR/.env | cut -d= -f2")
echo
echo "Deployed. Check: curl https://$DOMAIN/api/health"
