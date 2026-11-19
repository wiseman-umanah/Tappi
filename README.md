<img width="1309" height="660" alt="image" src="https://github.com/user-attachments/assets/9e7c82bb-a64c-49ef-981b-5f77a16bcfb5" />

# Tappi

Tap-to-pay wallet and merchant terminal (SoftPOS) for Nigeria. Customers hold naira, USDT, USDC and
Bitcoin, send to a @username, pay by tapping phones (NFC), QR or a short code, swap between
currencies, and get a USD virtual Visa card. Merchants take payments on their phone, refund, and
withdraw to their bank. Tappi AI answers questions and prepares payments by chat or voice, in
English, Pidgin, Yoruba, Hausa, Igbo and more.

## What's in this repository

| Folder | What | Stack |
| --- | --- | --- |
| [`mobile/`](mobile/README.md) | The app (customer wallet + merchant terminal), Android first | Expo SDK 58, React Native, Expo Router |
| [`backend/`](backend/README.md) | Everything server side | |
| [`backend/engine/`](backend/engine/README.md) | The money engine: the ledger, and the only thing that moves money (Paga, Bitnob) | Rust, axum, sqlx |
| [`backend/api/`](backend/api/README.md) | What the app talks to: sign-in, payments, Tappi AI | Python, FastAPI, SQLAlchemy |
| [`backend/deploy/`](backend/README.md#deploy) | Running it all on one server | Docker Compose, Caddy |
| [`frontend/`](frontend/README.md) | The landing page | Next.js (static export), Cloudflare Pages |
| [`AGENTS.md`](AGENTS.md) | Detailed notes on the app for contributors and coding agents | |

## How it fits together

```
 phone app ──HTTPS──▶  API (Python)  ──private──▶  engine (Rust)  ──▶  Paga   (naira: account numbers, bank payouts)
                           │                           │         ──▶  Bitnob (USDT/USDC/BTC, swaps, USD Visa card)
                           ▼                           ▼
                     Postgres: schema app      Postgres: schema engine (the ledger)
```

- **The engine owns the money.** Every balance change is a double-entry ledger entry in the engine;
  the API can't write the ledger (separate database roles). Paga and Bitnob hold the real money in
  Tappi's business accounts; the ledger says which user owns what.
- **Money between Tappi users** (sends, merchant payments, refunds, the Tappi card) is an instant
  ledger entry. Only money entering or leaving Tappi touches a provider.
- **Providers call back** (deposits, payout results) through the API's webhook URL, which passes the
  request to the engine; the engine checks the signature and applies it once.
- **Retries are safe:** money actions carry an idempotency key, so a retried request never moves
  money twice.

## Getting started

You need Docker, Rust (`cargo`), [`uv`](https://docs.astral.sh/uv/) for Python, Node with `pnpm`,
and an Expo account (app builds run on EAS, in the cloud).

```bash
# backend: Postgres + engine + API on your laptop
cd backend && ./dev.sh                  # API on :8080, docs at http://127.0.0.1:8080/docs

# app: Metro, for the development build on your phone (same Wi-Fi)
cd mobile && pnpm install && pnpm start

# landing page
cd frontend && pnpm install && pnpm dev
```

Each folder's README has the details: settings, tests, builds and deployment.

## Status

The backend runs against **Paga and Bitnob sandboxes**. While those can't fund test accounts, the
engine has a test-money mode (`ENGINE_SANDBOX=true`, testing only) and the `tappi-fund` command to
give testers balances; see [backend/README.md](backend/README.md#test-money). Waiting on providers:
Paga sandbox verification (account numbers, bank payouts) and Bitnob sandbox deposits and naira
trading. Bank-card charges at the terminal need a card acquirer and are refused for now.

Before real users: real email sending for sign-in codes (`TAPPI_AUTO_CODE=false`), a real domain,
`ENGINE_SANDBOX=false` with a fresh database, and database backups.

## Contributing

- Never commit secrets: every `.env` is git-ignored; copy from the `.env.example` next to it.
- Run the checks for what you changed: `pnpm typecheck && pnpm lint` (mobile, frontend),
  `uv run pytest` and `uv run ruff check` (api), `cargo test` and `cargo clippy` (engine).
