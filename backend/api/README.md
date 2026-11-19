# Tappi API

What the app talks to (Python, FastAPI, SQLAlchemy, Alembic). Sign-in, profiles, payments between
users, merchant charges, taps, the Tappi card and Tappi AI live here. Whenever money moves it asks
the [engine](../engine/README.md); it never writes balances itself.

**Browse it:** with the API running, open http://127.0.0.1:8080/docs (Swagger, grouped by area). Sign
in there with `POST /api/auth/code` → copy `devCode` → `POST /api/auth/verify` → copy `token` →
**Authorize**. New users: `PATCH /api/me` (name, handle, gender), then `POST /api/me/pin`.

## Conventions

- Paths are under `/api`; errors are `{"error": "message"}` written for the user.
- Amounts in and out are whole units (₦1250.50, 0.0001 BTC); converted exactly with `Decimal`.
- Money actions take an optional `Idempotency-Key` header: the app sends one per action and the
  same one on retry, so a retry never pays twice.
- Money actions check the user's 4-digit PIN (locks for 5 minutes after 5 wrong tries).
- Provider names never reach users in messages.

## Code (`src/tappi_api/`)

| File | What |
| --- | --- |
| `routes.py` | Every route (thin: they call the modules below) |
| `auth.py`, `security.py` | Email codes, sessions, PIN, account status checks |
| `wallet.py` | Profile, sends, activity |
| `merchant.py` | Charges, refunds, merchant dashboard |
| `taps.py`, `nearby.py` | NFC tap tokens, Bluetooth nearby beacons |
| `cards.py` | The Tappi card (the phone as a card, inside Tappi) |
| `banking.py` | Account numbers and bank withdrawals (Paga, via the engine); turns engine events into activity |
| `crypto.py`, `swaps.py`, `usd_card.py` | Crypto addresses and sends, swaps, the USD Visa card (Bitnob, via the engine) |
| `account.py` | Disable, delete, restore, close and purge accounts |
| `ai/` | Tappi AI: Groq (Whisper, chat with tools, Orpheus voice), Intron Sahara voices, 14 languages |
| `engine.py` | The engine client (retries, idempotent calls, error mapping) |
| `testmoney.py` | `tappi-fund`: test money for testers (test-money mode only) |
| `db.py`, `settings.py`, `money.py`, `errors.py` | Models, settings, amount conversion, errors |
| `../../migrations/` | Alembic migrations for schema `app` |

## Settings (`.env`, see `.env.example`)

| Variable | |
| --- | --- |
| `DATABASE_URL` | `postgresql+asyncpg://…`; the API uses schema `app` only |
| `SESSION_SECRET` | Protects sign-in codes and sessions (32+ characters) |
| `ENGINE_URL`, `ENGINE_TOKEN` | The engine (`http://127.0.0.1:8090`) and its shared secret |
| `TAPPI_AUTO_CODE` | `true` = the sign-in code comes back to the app (testers only, until email sending exists) |
| `API_HOST`, `API_PORT` | Where it listens (`0.0.0.0` so a phone on the same Wi-Fi can reach it) |
| `GROQ_API_KEY`, `INTRON_API_KEY` | Tappi AI (Intron is optional: African-language voices) |
| `CORS_ORIGINS` | Browser origins allowed (the Expo web build in development) |
| `NGN_PER_USD` | Display-only rate for "≈" amounts and merchant totals; never used to move money |
| `TIMEZONE` | Merchants' "today" (default `Africa/Lagos`) |
| `ACCOUNT_RESTORE_DAYS`, `PURGE_INTERVAL_S` | Account deletion window and how often closures run |

## Commands

```bash
uv run alembic upgrade head          # create/upgrade schema app
uv run tappi-api                     # serve (http://127.0.0.1:8080)
uv run tappi-purge                   # close deleted accounts past their window (also runs in the background)
uv run tappi-fund @ada NGN 50000     # test money (engine must run with ENGINE_SANDBOX=true)
uv run pytest                        # needs `cargo build` in ../engine
uv run ruff check && uv run ruff format
```

Tests start the real engine on a throwaway database and never read your `.env` or call real
services (Tappi AI runs against a scripted Groq).

**One API process:** Tappi AI voice clips (5 minutes) and the background tasks live in the process,
so run one instance until those move to shared storage.
