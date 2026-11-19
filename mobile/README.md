# Tappi app

Tap-to-pay wallet and merchant terminal (SoftPOS) for Android, built with Expo SDK 58 and React
Native. The server side (money engine and API) is in [`../backend`](../backend/README.md); this app
holds no keys, secrets or server code.

- **Customers:** naira, USDT, USDC and Bitcoin balances; add money by bank transfer to their own
  account number or by crypto deposit; send to a @username; pay merchants by tapping phones (NFC),
  QR, a short code or the nearby list; swap between currencies; withdraw to a bank or send crypto
  out; the Tappi card (the phone itself); a USD virtual Visa card for online payments; Tappi AI.
- **Merchants:** charge in naira or USDC, take taps from customers' phones, refund, see the day's
  sales, and withdraw to their bank.

More detail for contributors (and coding agents): [AGENTS.md](../AGENTS.md).

## Run it

Start the backend first (`cd ../backend && ./dev.sh`). Then:

```bash
pnpm install
pnpm start              # Metro, for the development build
```

Install the development build on your phone once (`pnpm build:dev`, built in the cloud by EAS) and
open it with the phone on the same Wi-Fi as the laptop. It calls the API on port 8080 of the laptop
running Metro. To use another API (a tunnel, the server), set `EXPO_PUBLIC_API_URL` in `.env.local`.

## Builds

| Command | What |
| --- | --- |
| `pnpm build:dev` | Development build (loads the app from Metro). Rebuild after changing native settings in `app.json` |
| `pnpm build:preview` | Standalone APK for testers. Talks to the API in `eas.json` (`EXPO_PUBLIC_API_URL`) |

Builds include 64-bit and 32-bit ARM, with code shrinking. Testers install the APK from the EAS link;
on Android they may need "Install unknown apps" and to tap through Play Protect's warning. A Play
Console internal-testing track avoids both.

## Checks

```bash
pnpm typecheck && pnpm lint
```

## Not available yet

- **Real money flows** wait on the providers' sandboxes (Paga verification, Bitnob deposits); testers
  can be given test money meanwhile (see the backend README).
- **Bank-card charges** at the terminal need a card acquirer; they're refused with a clear message.
- **Sign-in codes** are handed to the app while `TAPPI_AUTO_CODE` is on (testers only); real email
  sending comes before launch.
