# Tappi engine

The money engine (Rust, axum, sqlx). It is the **only** part of Tappi that changes balances, and the
only part that talks to Paga and Bitnob. It is private: only the API calls it, with a shared token,
and it is never exposed to the internet (provider webhooks reach it through the API).

## Rules it enforces

- **Amounts are integers** in each asset's smallest unit: NGN kobo (2 places), USDT/USDC
  micro-dollars (6), BTC satoshis (8). No floats anywhere.
- **Double entry:** every movement is a journal entry whose postings sum to zero per asset; a
  deferred database trigger refuses any entry that doesn't. Journal entries and postings are
  append-only (corrections are new entries).
- **No overdrafts:** user balances can't go below zero (checked, then enforced by a CHECK
  constraint). Only system accounts (provider clearing, fees, the test mint) can.
- **Idempotency:** every write takes an idempotency key. Same key + same request returns the
  original result; same key + a different request is refused (409).
- **Holds:** money in flight (a payout, a card top-up, a swap) is reserved first, then captured
  when the provider confirms or released when it refuses.
- **Providers:** every call is recorded before it's made (`provider_ops`); unclear answers are never
  resent blindly (looked up or retried only where the provider deduplicates); every webhook is
  stored, signature-checked and applied once (`webhook_events`); provider fees are Tappi's cost;
  balances are reconciled with each provider every hour.

## Code

| File | What |
| --- | --- |
| `src/ledger.rs` | Accounts, journal entries, postings, holds, transfers, account closure |
| `src/http.rs` | The HTTP API and webhook receivers |
| `src/config.rs` | Settings from the environment |
| `src/providers/mod.rs` | What every provider shares: operations, webhooks, deposits, fees, events |
| `src/providers/paga.rs` | Paga: customer account numbers, deposit webhooks, bank payouts, reconciliation |
| `src/providers/bitnob.rs` | Bitnob: request signing, deposit addresses, crypto deposits and sends |
| `src/providers/trading.rs` | Swaps through Bitnob's trading API |
| `src/providers/usdcard.rs` | USD virtual Visa cards: KYC, create, fund, withdraw, freeze, terminate |
| `src/providers/testswap.rs` | Test swaps at fixed rates (test-money mode only) |
| `migrations/` | Database schema (`engine` schema), applied on start |
| `tests/` | One file per area; fake Paga and Bitnob servers check our request signatures |

## Settings (`.env`, see `.env.example`)

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres. The engine uses schema `engine` only |
| `ENGINE_TOKEN` | Shared secret the API sends (32+ characters) |
| `ENGINE_ADDR` | Where it listens (default `127.0.0.1:8090`) |
| `PUBLIC_URL` | Tappi's public https address; providers' webhooks go to `{PUBLIC_URL}/api/webhooks/…` |
| `PAGA_ENV`, `PAGA_PUBLIC_KEY`, `PAGA_SECRET_KEY`, `PAGA_HASH_KEY` | Paga (`sandbox` or `live`). All three keys or none |
| `BITNOB_CLIENT_ID`, `BITNOB_CLIENT_SECRET`, `BITNOB_WEBHOOK_SECRET` | Bitnob. All three or none |
| `CARD_CREATION_FEE_USD`, `CARD_TOPUP_FEE_USD`, `CARD_TOPUP_FEE_PERCENT`, `CARD_TOPUP_PERCENT_FROM_USD` | USD card prices charged to users (default: Bitnob's published fees) |
| `ENGINE_SANDBOX` | **Testing only.** `true` enables the test mint (`tappi-fund`) and test swaps |
| `TEST_NGN_PER_USD`, `TEST_USD_PER_BTC` | Test swap rates (default 1569 and 68000) |
| `RUST_LOG` | Log level (`info`) |

A provider whose keys are missing is simply off; its routes answer "not configured".

## HTTP API

Everything under `/v1` needs `Authorization: Bearer $ENGINE_TOKEN`. Errors are
`{"error": {"code", "message"}}`, e.g. 422 `insufficient_funds`, 409 `idempotency_conflict`.

| Route | |
| --- | --- |
| `GET /health` | No token. 200 when the database answers |
| `POST /v1/transfers` | Move money between two users |
| `GET /v1/owners/{type}/{id}/balances` | Balance, held and available for every asset |
| `POST /v1/holds`, `GET /v1/holds/{id}`, `POST …/capture`, `POST …/release` | Reserve, settle or give back |
| `GET /v1/entries/by-key/{key}` | Did a request that timed out go through? |
| `POST /v1/owners/user/{id}/close` | Account closure: sweep what's left to `closed_accounts` |
| `GET /v1/events?after=` | What happened to users (deposits, payouts, swaps…), for the API's activity feed |
| `GET /v1/ops/{id}` | A provider operation's status |
| `POST /v1/paga/accounts`, `GET /v1/paga/banks`, `POST /v1/paga/resolve`, `POST /v1/paga/payouts`, `GET /v1/paga/reconcile` | Paga |
| `POST /v1/bitnob/addresses`, `POST /v1/bitnob/sends`, `GET /v1/bitnob/reconcile` | Bitnob crypto |
| `POST /v1/swaps/quote`, `POST /v1/swaps` | Swaps (test swaps while `ENGINE_SANDBOX=true`) |
| `GET /v1/usd-cards/fees`, `/occupations`, `POST /v1/usd-cards/kyc`, `GET /v1/usd-cards/{owner}`, `…/kyc`, `…/secrets`, `…/transactions`, `POST …/create`, `…/fund`, `…/withdraw`, `…/frozen`, `…/terminate` | USD card |
| `POST /v1/sandbox/credit`, `/debit` | Test mint (`ENGINE_SANDBOX=true` only) |
| `POST /webhooks/paga/funding`, `/webhooks/paga/payout`, `/webhooks/bitnob/events` | Provider webhooks (no token: trusted only if the signature checks out) |

## Run and test

```bash
docker compose -f ../docker-compose.yml up -d db       # Postgres on 127.0.0.1:5433
cp .env.example .env                                   # set ENGINE_TOKEN (openssl rand -hex 32)
set -a; . ./.env; set +a; cargo run                    # migrates, then listens
DATABASE_URL=postgres://tappi:tappi@127.0.0.1:5433/tappi cargo test
cargo clippy --all-targets
```

Usually you run it through `../dev.sh` together with the API. Each test gets its own throwaway
database; provider tests run against fake servers that check signatures the way the providers'
docs describe (Bitnob's webhook check is also tested against Bitnob's published example).
