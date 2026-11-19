# Tappi backend

| Part | What | Stack |
| --- | --- | --- |
| [`engine/`](engine/README.md) | The money engine: the double-entry ledger, and the only part that moves money or talks to Paga and Bitnob. Private | Rust · axum · sqlx |
| [`api/`](api/README.md) | What the app talks to: sign-in, payments, merchant charges, taps, Tappi AI. Asks the engine to move money | Python · FastAPI · SQLAlchemy |
| `deploy/` | One-server deployment: Postgres, engine, API and Caddy (HTTPS) with Docker Compose | Docker |
| `docs/` | What we use from [Paga](docs/paga.md) and [Bitnob](docs/bitnob.md), and the open questions for them | |

One Postgres, two schemas: `engine` (the ledger, Rust) and `app` (users, charges, chats; Python).
On the server each service has its own database role, so the API can't touch the ledger.

## Money providers

| | Paga (naira) | Bitnob (crypto and USD) |
| --- | --- | --- |
| Money in | Each user's own account number; bank transfers to it are credited by webhook | A deposit address per user per network; crypto deposits credited by webhook |
| Money out | Withdraw to any Nigerian bank | Send USDT/USDC/BTC to outside addresses |
| Also | | Swaps (NGN, USDT, USDC, BTC) and the USD virtual Visa card |

Keys live only in `engine/.env` (and the server's `.env`). Paga and Bitnob post webhooks to
`https://<public address>/api/webhooks/{paga|bitnob}/…`; the API passes them to the engine, which
checks the signature and applies each one once.

## Run it locally

```bash
cp engine/.env.example engine/.env    # set ENGINE_TOKEN (openssl rand -hex 32), provider keys if you have them
cp api/.env.example api/.env          # set SESSION_SECRET, and the same ENGINE_TOKEN
./dev.sh                              # Postgres (Docker), engine on :8090, migrations, API on :8080
```

Ctrl-C stops it all. API docs: **http://127.0.0.1:8080/docs**. A phone on the same Wi-Fi reaches the
API at the laptop's address (`dev.sh` prints it); if it can't, open port 8080 in the firewall
(`sudo ufw allow from 192.168.0.0/16 to any port 8080 proto tcp`).

**Provider webhooks** need a public https address. In development: `ngrok http 8080
--url=<your-static-domain>`, set `PUBLIC_URL=https://<your-static-domain>` in `engine/.env`, and
register `https://<domain>/api/webhooks/bitnob/events` in Bitnob's dashboard. Both providers also
allow-list the IP addresses that may call their APIs.

## Test money

While Paga and Bitnob can't fund sandbox accounts, testers can be given **test money**:

1. Run the engine with `ENGINE_SANDBOX=true` (`engine/.env`, or the server's `.env`).
2. Give money: `uv run tappi-fund @ada NGN 50000` in `api/` (on the server:
   `docker compose exec api tappi-fund @ada NGN 50000`). It shows as "Test money" in their activity.
3. Testers can send to each other, pay merchants, refund, use the Tappi card, and **swap at fixed
   test rates** (₦1,569/$, $68,000/BTC; `TEST_NGN_PER_USD`, `TEST_USD_PER_BTC`), labelled
   "Test rate" in the app. Withdrawals and crypto sends of test money are refused by the providers.

**Before real money:** `ENGINE_SANDBOX=false` and a fresh database, so test money never sits next
to real balances. The engine logs a warning at start-up while the mint is on.

## Tests

```bash
cd engine && DATABASE_URL=postgres://tappi:tappi@127.0.0.1:5433/tappi cargo test
cd api && uv run pytest              # needs `cargo build` in engine/ (it starts the real engine)
```

Each test gets a fresh database. Covered: balanced books, no overdrafts under concurrency, no
deadlocks, idempotent retries, holds, append-only rows, provider flows against fake Paga and Bitnob
servers that check our signatures, swaps, cards, account lifecycle, and Tappi AI with a scripted model.

## Deploy

`deploy/` runs everything on one server: Postgres, the engine, the API and Caddy, which serves
`/api/*` over HTTPS (automatic Let's Encrypt certificates). Only Caddy is reachable from outside.

Build on your laptop and ship the images (the server never compiles, so a 1 GB droplet is enough):

```bash
# once, on the server
curl -fsSL https://get.docker.com | sh

# from your laptop, every deploy
cd deploy
./ship.sh root@<server-ip>       # first run puts a template in /opt/tappi/.env and stops: fill it in, run again
curl https://<domain>/api/health
```

- **Domain:** `TAPPI_DOMAIN` in the server's `.env`. Without one, `<ip-with-dashes>.sslip.io` works
  for testing (e.g. `46-101-17-187.sslip.io`).
- **Secrets:** the five passwords and tokens in `.env` are made up once (`openssl rand -hex 32`); don't
  change the database ones after the first start.
- **Database roles:** on first start `db-init/01-roles.sh` creates `tappi_engine` and `tappi_api`, each
  owning its own schema.
- **Migrations** run on start (the engine's own, and `alembic upgrade head` for the API).
- **Backups:** not automated yet. At least nightly:
  `docker compose exec db pg_dump -U postgres tappi | gzip > tappi-$(date +%F).sql.gz`, copied off the server.
- **The app:** `EXPO_PUBLIC_API_URL` in `mobile/eas.json` must be the server's https address.
