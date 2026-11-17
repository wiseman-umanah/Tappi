# Tappi

Tap-to-pay wallet and merchant terminal (SoftPOS) for Android, on Stellar **testnet**.

- **Customers:** naira and USDC balances, send to a @username, pay by tapping phones (NFC), QR or
  code, swap between the two, a Tappi card on the phone, and Tappi AI (chat and voice).
- **Merchants:** charge in naira or USDC, take taps from phones and contactless cards, refund,
  settle.

## How it's built

| Part | What | Where |
| --- | --- | --- |
| App | Expo SDK 58 / React Native, Expo Router | `src/app`, `src/lib`, `src/components` |
| Server | Expo Router API routes, run as one Node process | `src/app/api`, `src/server`, `server.mjs` |
| Database | Postgres (hosted) or PGlite (local, no setup) | `src/server/db`, `drizzle/` |
| Wallets and sign-in | Email code; wallet keys held by the server, encrypted | `src/server/auth.ts`, `src/server/stellar/accounts.ts` |
| Money | Stellar testnet: USDC (Circle test USDC) and NGN (Tappi's own test naira) | `src/server/stellar` |

Users sign in with an email code. Each user gets a Stellar wallet whose key the server keeps,
encrypted with `WALLET_ENCRYPTION_KEY`. For every payment the server checks the PIN, signs with the
user's wallet, pays the network fee from Tappi's treasury and submits it.

While this is for internal testers, no email is sent: the server hands the code to the app, which
fills it in. Anyone with the app can therefore sign in as any email address. Set
`TAPPI_AUTO_CODE=false` on the server to stop that (codes are then only in the server log).

More detail for contributors (and coding agents) is in [AGENTS.md](AGENTS.md).

## Run it locally

```bash
pnpm install
pnpm secrets            # creates .env.local with a session secret and wallet encryption key
# add GROQ_API_KEY to .env.local (see .env.example)
pnpm stellar:bootstrap  # once: treasury, test naira, swap liquidity on testnet
pnpm start              # dev server + API, for the development build on your phone
```

The development build (`pnpm build:dev`, built on EAS) talks to the dev server on your computer.
`GET /api/health` shows whether the database and treasury are reachable.

## Deploy

**Server (Render):** `render.yaml` is a Blueprint. Render → New → Blueprint → this repo, then paste
`DATABASE_URL`, `TREASURY_SECRET`, `GROQ_API_KEY` and `INTRON_API_KEY`. Render generates
`SESSION_SECRET` and `WALLET_ENCRYPTION_KEY`; never change the second one, it decrypts every
wallet. The database is migrated on start. Check `https://<service>.onrender.com/api/health`.

**App (EAS):** `pnpm build:preview` builds a standalone APK in the cloud. It gets its server address
from `eas.json`, not from `.env.local`, so it needs no dev server or tunnel. Deploy the server first
and make sure the address in `eas.json` matches.

## Checks

```bash
pnpm typecheck && pnpm lint
```

To try the API without touching your local database, run a second server on a copy:
`PGLITE_DIR=/tmp/tappi-test pnpm start --port 8090`.

## Not real yet

Testnet only. Bank-card charges and the Tappi card are simulated (no card issuer or acquirer), bank
settlement is a stand-in, and naira is a test token issued by Tappi.
