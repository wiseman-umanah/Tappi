# Tappi

Tap-to-pay wallet and merchant terminal (SoftPOS) for Android. This folder is the app; the server
side (money engine and API) is in [`../backend`](../backend/README.md).

- **Customers:** naira and dollar balances, send to a @username, pay by tapping phones (NFC), QR or
  code, a Tappi card on the phone, and Tappi AI (chat and voice).
- **Merchants:** charge in naira or USDC, take taps from phones and contactless cards, refund,
  settle.

## How it's built

| Part | What | Where |
| --- | --- | --- |
| App | Expo SDK 58 / React Native, Expo Router | `src/app`, `src/lib`, `src/components` |
| API | Python (FastAPI): what the app talks to | `../backend/api` |
| Money engine | Rust: double-entry ledger, Bitnob and Paga (coming) | `../backend/engine` |

Users sign in with an email code. Balances live in the engine's ledger; the app never holds keys or
secrets. Money actions are approved with the user's PIN, which the API checks.

While this is for internal testers the API runs in sandbox mode: money is test money, and the login
code is handed to the app, which fills it in (so anyone with the app can sign in as any email).
Turn off `TAPPI_AUTO_CODE` on the API once real email sending exists.

More detail for contributors (and coding agents) is in [AGENTS.md](../AGENTS.md).

## Run it locally

Start the backend first (see `../backend/README.md`): Postgres, the engine, then the API with
`API_HOST=0.0.0.0` so your phone can reach it. Then:

```bash
pnpm install
pnpm start              # Metro, for the development build on your phone
```

The development build (`pnpm build:dev`, built on EAS) loads the app from Metro and calls the API on
port 8080 of the same laptop. Set `EXPO_PUBLIC_API_URL` in `.env.local` to use another API instead.

## Builds

`pnpm build:preview` builds a standalone APK in the cloud. It gets the API address from `eas.json`
(`EXPO_PUBLIC_API_URL`), so deploy the backend first and make sure that address is right.

## Checks

```bash
pnpm typecheck && pnpm lint
```

## Not real yet

Sandbox only. Swaps are coming (Bitnob), bank-card charges and the Tappi card are simulated (no card
issuer or acquirer), and merchant settlement is a stand-in until Paga payouts.
