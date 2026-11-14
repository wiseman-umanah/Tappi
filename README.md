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
| Wallets and sign-in | [Pollar](https://docs.pollar.xyz) | `src/lib/pollar*.ts`, `src/server/pollar.ts` |
| Money | Stellar testnet: USDC (Circle test USDC) and NGN (Tappi's own test naira) | `src/server/stellar` |

Users sign in with a code Pollar emails them, and Pollar holds their Stellar wallet. **Tappi stores
no user keys.** For every payment the server checks the PIN and builds the transaction, the phone
signs it through Pollar, and the server verifies it, pays the network fee from Tappi's treasury and
submits it.

More detail for contributors (and coding agents) is in [AGENTS.md](AGENTS.md).

## Run it locally

```bash
pnpm install
pnpm secrets            # creates .env.local with a session secret
# add the Pollar keys, GROQ_API_KEY and the Stellar secrets to .env.local (see .env.example)
pnpm stellar:bootstrap  # once: treasury, test naira, swap liquidity on testnet
pnpm start              # dev server + API, for the development build on your phone
```

The development build (`pnpm build:dev`, built on EAS) talks to the dev server on your computer.
`GET /api/health` shows whether the database and treasury are reachable.

## Deploy

**Server (Render):** `render.yaml` is a Blueprint. Render → New → Blueprint → this repo, then paste
`DATABASE_URL`, `TREASURY_SECRET`, `POLLAR_SECRET_KEY`, `GROQ_API_KEY` and `INTRON_API_KEY`. The
database is migrated on start. Check `https://<service>.onrender.com/api/health`.

**App (EAS):** `pnpm build:preview` builds a standalone APK in the cloud. It gets its server address
and Pollar publishable key from `eas.json`, not from `.env.local`. Deploy the server first and make
sure the address in `eas.json` matches.

**Pollar app settings** (dashboard.pollar.xyz, Test mode): the publishable key must have *Allow
native clients* on; funding mode *Deferred*; signature confirmation *Auto*.

## Checks

```bash
pnpm typecheck && pnpm lint
pnpm e2e:standin        # payments end to end on testnet, with a stand-in for Pollar (no emails)
pnpm e2e a@x.com b@x.com  # the same through real Pollar; asks for the emailed codes
```

Both end-to-end commands need a running server (`PGLITE_DIR=/tmp/tappi-e2e pnpm start --port 8090`;
add `POLLAR_SERVER_URL=http://localhost:8099` for the stand-in) and move real testnet money.

## Not real yet

Testnet only. Bank-card charges and the Tappi card are simulated (no card issuer or acquirer), bank
settlement is a stand-in, and naira is a test token issued by Tappi.
