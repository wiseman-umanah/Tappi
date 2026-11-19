# Tappi backend

| Part | What | Stack |
| --- | --- | --- |
| `engine/` | The money engine: ledger, holds, transfers; later swaps, deposits, payouts, Bitnob and Paga, webhooks, reconciliation. The only thing that changes balances. Private: only `api/` calls it. | Rust · axum · sqlx |
| `api/` | What the app talks to: auth, users, PIN, send, activity, charges, taps, nearby, Tappi card, Tappi AI. Asks the engine to move money. | Python · FastAPI · SQLAlchemy · Alembic |

One Postgres, two schemas: `engine` (Rust) and `app` (Python). In production each service gets
its own database role, so the API can't write the ledger.

## Engine rules

- Amounts are integers in the asset's smallest unit: NGN kobo (2), USDT/USDC (6), BTC satoshis (8).
- Every movement is a journal entry whose postings sum to zero per asset. A deferred trigger
  refuses any entry that doesn't balance; journal entries and postings are append-only.
- Every write takes an `idempotency_key`. Same key + same request → the original result
  (`replayed: true`, HTTP 200). Same key + different request → 409 `idempotency_conflict`.
- User accounts can't go negative (checked, then enforced by a CHECK constraint). System accounts
  (provider clearing, sandbox mint) can.
- `/v1/transfers` only moves money between users. System accounts move only inside the engine.

## API (all under `/v1`, `Authorization: Bearer $ENGINE_TOKEN`)

| | |
| --- | --- |
| `GET /health` | No token. 200 when the database answers. |
| `POST /v1/transfers` | `{idempotency_key, kind, from, to, asset, amount, reference?, metadata?}`; owners are `{owner_type: "user", owner_id}` |
| `GET /v1/owners/{owner_type}/{owner_id}/balances` | Every asset: `balance`, `held`, `available` |
| `POST /v1/holds` | Reserve money: `{idempotency_key, owner, asset, amount, reference?}` |
| `GET /v1/holds/{id}` | |
| `POST /v1/holds/{id}/capture` | `{to, kind, metadata?}`; capturing twice returns the same entry |
| `POST /v1/holds/{id}/release` | Give it back; releasing twice is fine |
| `GET /v1/entries/by-key/{key}` | Did a request that timed out go through? |
| `POST /v1/owners/user/{id}/close` | Account closure: sweeps every balance to `closed_accounts`; refused while money is on hold |
| `POST /v1/sandbox/credit` / `debit` | Automated tests only (`ENGINE_SANDBOX=true`): mint and burn test money. Off everywhere else |

Errors are `{"error": {"code", "message"}}`, e.g. 422 `insufficient_funds`.

## Providers (Paga, Bitnob)

The engine talks to them; keys live only in `engine/.env` (see `engine/.env.example`) and the
deploy `.env`. Each provider turns on only when all its keys are set. Spec notes and open questions:
`docs/paga.md`, `docs/bitnob.md`.

- Every call is recorded first (`engine.provider_ops`); payouts hold the user's money until the
  provider confirms, and give it back on a clear failure. Unclear answers are never resent: Paga
  payouts are re-checked with `transactionStatus`, Bitnob sends wait for the webhook.
- Webhooks are stored before they're applied (`engine.webhook_events`) and deduplicated, so a
  repeated delivery never credits twice. Deposits to an unknown account are kept with an error.
- Provider fees are booked as Tappi's cost (`paga_fees`, `bitnob_fees`); users get the full amount.
- Reconciliation runs hourly and logs an error if a provider holds less than Tappi owes users.
- Webhooks need a public address: `PUBLIC_URL` (your ngrok static domain in development).

## Run it

One command (needs `engine/.env` and `api/.env`, copied from the `.env.example` files with the same
`ENGINE_TOKEN` in both):

```bash
./dev.sh            # Postgres, engine, migrations, API. Ctrl-C stops it all.
```

Then open **http://127.0.0.1:8080/docs** (Swagger; raw spec at `/openapi.json`). Sign in there:
`POST /api/auth/code` → copy `devCode` → `POST /api/auth/verify` → copy `token` → **Authorize**.

By hand, step by step:

```bash
docker compose up -d db          # Postgres on 127.0.0.1:5433 (first start takes ~30 s to initialise)
cd engine
cp .env.example .env             # set ENGINE_TOKEN: openssl rand -hex 32
set -a; . ./.env; set +a
cargo run                        # migrates, then listens on ENGINE_ADDR
```

Then the API, in another terminal:

```bash
cd api
cp .env.example .env             # set SESSION_SECRET, and ENGINE_TOKEN to the engine's
uv run alembic upgrade head      # creates schema `app`
uv run tappi-api                 # http://127.0.0.1:8080, docs at /docs
```

## API (`/api`, same paths and `{"error": "…"}` responses as the old Expo routes)

`POST /api/auth/code`, `POST /api/auth/verify`, `POST /api/auth/logout`, `GET|PATCH /api/me`,
`POST /api/me/pin`, `POST /api/me/pin/check`, `GET /api/handles/{handle}`, `GET /api/users/{handle}`,
`POST /api/me/receiving`, `POST /api/me/delete`, `POST /api/me/restore`, `POST /api/send`,
`GET /api/activity`, `GET /api/rate`, `GET /api/health`.
Charges: `POST /api/requests`, `GET /api/requests/{id or code}`, `POST /api/requests/{id}/pay`,
`/cancel`, `/refund`, `/tap`, `/tappi-card`, `/card` (refused: no card acquirer), `GET /api/merchant`.
Taps and nearby: `POST|GET /api/taps`, `POST /api/taps/person`, `POST|DELETE /api/nearby/beacon`,
`POST /api/nearby/resolve`. Tappi card: `GET|PATCH /api/card`, `POST /api/card/details`,
`POST|DELETE /api/card/arm`. Tappi AI: `GET /api/ai/languages`, `POST /api/ai/chat`, `POST /api/ai/voice`,
`GET /api/ai/conversations`, `GET|DELETE /api/ai/conversations/{id}`, `GET /api/ai/speech/{id}/ready`,
`GET /api/ai/speech/{id}`. Voice clips are kept in the API process's memory for 5 minutes, so run one
API process (not several behind a load balancer) until they move to shared storage.

Money in and out: `GET|POST /api/wallet/bank-account` (the user's own NUBAN, Paga),
`GET /api/banks`, `POST /api/banks/resolve`, `POST /api/withdraw`, `GET /api/withdrawals/{id}`,
`GET /api/crypto/networks`, `POST /api/crypto/address` (Bitnob), `POST /api/crypto/send`,
`GET /api/crypto/sends/{id}`, `POST /api/swap/quote`, `POST /api/swap`, `GET /api/swaps/{id}`,
`GET /api/usd-card` (+ `/occupations`, `/kyc`, `/fund`, `/withdraw`, `/freeze`, `/terminate`,
`/details`, `/transactions`; `POST /api/usd-card` creates it). Providers' webhooks arrive at `POST /api/webhooks/{paga|bitnob}/{kind}`
and are passed untouched to the engine, which checks the signature.

Deleted accounts past their restore window are closed by a background task every
`PURGE_INTERVAL_S` seconds (default 600), or on demand with `uv run tappi-purge` (for cron).

Money actions accept an `Idempotency-Key` header: the phone sends a fresh one per action and the
same one on retry, so a retried send never pays twice. Amounts in and out are whole units
(₦1250.50, 0.0001 BTC); the API converts to smallest units with Decimal before calling the engine.

## Test it

```bash
cd engine
DATABASE_URL=postgres://tappi:tappi@127.0.0.1:5433/tappi cargo test

cd ../api
uv run pytest                    # needs `cargo build` in engine/: starts the real engine on a throwaway database
                                 # (Tappi AI tests use a scripted Groq: no network, no key needed)
```

Each test gets a fresh database. Covered: balanced books, no overdrafts under 25 concurrent
debits, no deadlock with opposite transfers at once, idempotent replay and conflict, holds
(reserve, capture once, release), append-only rows, the unbalanced-entry trigger, token auth,
sandbox gating, and that system accounts can't be moved through the API.

## Deploy (your own server)

`deploy/` runs everything on one server with Docker Compose: Postgres, the engine, the API, and
Caddy in front (HTTPS with automatic Let's Encrypt certificates). Only Caddy is reachable from the
internet; it serves `/api/*` and nothing else. The engine is on the private Docker network only.

Build on your laptop, ship to the server (the server never compiles, so a 1 GB droplet is fine):

```bash
# once, on the server: install Docker, point the domain's DNS at it
curl -fsSL https://get.docker.com | sh

# from your laptop, every deploy
cd backend/deploy
./ship.sh root@<server-ip>       # first run copies .env.example to /opt/tappi/.env: fill it in, run again
curl https://<your domain>/api/health
```

Or build and run on the server itself: copy `backend/` there and `docker compose up -d --build`
(needs about 2 GB of RAM for the Rust build).

- **Separate database roles:** on first start, `db-init/01-roles.sh` creates `tappi_engine` (owns
  schema `engine`) and `tappi_api` (owns schema `app`). The API's role can't read or write the
  ledger. This only runs when the database volume is new.
- **Migrations** run on start: the engine applies its own, the API runs `alembic upgrade head`.
- **One API process:** voice clips and the account purge loop live in the API process.
- **Backups:** nothing backs the database up yet. At minimum, a nightly
  `docker compose exec db pg_dump -U postgres tappi | gzip > tappi-$(date +%F).sql.gz` copied off the
  server.
- **The app:** set `EXPO_PUBLIC_API_URL` in `mobile/eas.json` to `https://<your domain>` before
  building.
