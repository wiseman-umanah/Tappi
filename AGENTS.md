This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Tappi project notes

- **Product:** Tappi SoftPOS — native mobile app (customer wallet + merchant terminal). The PRD in
  `design/` says "web app / PWA first"; that is outdated — this is a native app.
- **Money providers:** **Bitnob** (USDT, USDC, BTC, swaps, USD virtual cards, international payouts)
  and **Paga** (NGN accounts, collections, bank payouts). Stellar is gone. Not in the PRD yet.
- **Designs:** `design/screens/*.png` (393×852). Each route file names the screen it implements.
- **Package manager:** pnpm only, `nodeLinker: hoisted` (set in `pnpm-workspace.yaml`, required by
  React Native tooling). Use `pnpm expo install <pkg>` for Expo/RN packages.
- **Builds:** cloud only via EAS — no Android Studio, SDK, or Gradle on the dev machine.
  `pnpm build:dev` → install APK on phone → `pnpm start`. Before the first dev build, `pnpm start:go`
  runs the app in Expo Go.
- **Styling:** NativeWind v4 (Tailwind v3). Palette lives in `src/theme/colors.js` (shared with
  `tailwind.config.js`); only those colors exist as classes. Use `cn()` from `@/lib/cn` to merge classes.
- **Text:** always `Text` from `@/components/text` (Creato Display, white). Pick weight with the
  `weight` prop, never `font-bold`/`font-*` classes — Android needs one font file per weight.
- **Icons:** Remix Icon via `<Icon name="wallet-3-line" />` from `@/components/icon` (font-based,
  names without `ri-`). `pnpm icons:sync` regenerates the glyph map after upgrading `remixicon`.
- **Feedback & motion:** `tapFeedback()` in `@/lib/feedback` (sounds + haptics);
  `ScanFrame`, `NfcPulse`, `TapResult` in `@/components/motion`.
- Expo Router 58 tab bars get `emitter` / `navigateToTab` props (not `navigation`); import `Tabs` from
  `expo-router/js-tabs`.

## Backend (`../backend`, not in this app)

The server side lives in `backend/` at the repo root (see `backend/README.md`): a **Rust money
engine** (`backend/engine`: double-entry ledger, the only thing that changes balances; later the
Bitnob and Paga adapters) and a **Python API** (`backend/api`, FastAPI: what this app talks to).
This app holds no keys, secrets or server code.

- **App ↔ API:** screens call `api()` from `@/lib/api` and hooks in `@/lib/queries` (TanStack Query).
  Response types are hand-written in `@/lib/api-types`: when an endpoint changes in
  `backend/api/src/tappi_api`, update its type there. Errors come back as `{ error: "…" }`.
- **API address:** `EXPO_PUBLIC_API_URL` (builds get it from `eas.json`). Unset in development, the
  app calls port 8080 on the laptop running Metro: run the API with `API_HOST=0.0.0.0`.
  `pnpm start:remote` (tunnel) can't reach the laptop's API, so set `EXPO_PUBLIC_API_URL` for it.
- **Money actions** go through `/approve` (PIN checked server-side). Sends and settlements carry an
  `Idempotency-Key` (`idempotencyKey()` from `@/lib/api`, one per approval screen) so a retry never
  pays twice. Amounts are whole units (₦1250.5, 2.5 USDC); the server converts exactly.
- **Assets:** the backend holds NGN, USDT, USDC and BTC. Screens show NGN and USDC (the Profile
  balances card shows all four). `money()` in `@/lib/format` formats any of them.
- **Money in and out:** Add Money shows the user's own account number (Paga NUBAN; bank transfers to
  it land in the naira balance) and links to Receive crypto (`/crypto/receive`: a Bitnob address per
  coin and network, with QR). Withdraw (`/withdraw`: bank picker, account name checked before the
  PIN) and Send crypto (`/crypto/send`) end in `/approve` (actions `withdraw`, `crypto`); both can
  come back `pending` until the bank or network confirms, then show in activity.
- **Swaps** (`/swap`, Bitnob trading): pick from/to and an amount → `POST /api/swap/quote` (exact
  send/receive, expires in seconds) → `/approve` (action `swap`) sends only the `quoteId`; the server
  executes the amounts it stored. Naira swaps also need Bitnob to enable NGN trading.
- **USD card** (`/usd-card`, Bitnob virtual Visa; linked from the Cards tab): card KYC (BVN/NIN) →
  create with $2–$2,500 paid from USDT/USDC (+ $1 + top-up fee) → `/approve` actions `card_create`,
  `card_fund`, `card_withdraw`. Its balance lives at Bitnob; details only after the PIN, never stored.
  Not the Tappi card (the phone itself).
- **No fake money:** money only arrives through Paga (bank transfer to the user's account number) or
  Bitnob (crypto). The providers' sandboxes supply test money.
- **Not available yet:** paying a charge from the other currency (swap first), bank-card charges at
  the terminal (no card acquirer: refused clearly). The merchant dashboard's withdraw button opens
  `/withdraw`. The `≈` equivalents use an indicative rate (`GET /api/rate`), never a rate money moves at.
- **Login:** email code. While `TAPPI_AUTO_CODE` is on, `/api/auth/code` returns `devCode` and the verify screen types
  it in (server setting `TAPPI_AUTO_CODE=false` stops that). Sign-in gating lives in
  `src/app/_layout.tsx` (`Stack.Protected`).
- **Payments:** Terminal → `/charge/[id]` (QR + 6-char code, NFC when available) ↔ customer
  `/pay` → `/pay/[code]` → `/approve`. Links are `tappi://pay/<CODE>`. A charge is in NGN or USDC
  and is paid from the balance in that currency.
- **NFC:** `src/lib/nfc.ts`. The merchant's phone is the reader (`useNfcTerminal`,
  react-native-nfc-manager in Android reader mode): it reads bank cards (`src/lib/emv.ts`: brand
  from the card's application ID, no card number) and customers' phones. The customer's phone
  presents itself as an NDEF Type 4 tag carrying `tappi://tap/<token>` (`useNfcPresent`, local
  module `modules/tappi-hce`); the merchant posts the token to `/api/requests/:id/tap` and the
  customer's Pay screen, polling `GET /api/taps`, opens the charge for the PIN (see Tap mode).
  Bank-card charges are simulated in the sandbox. No tap within 30 s → the QR code goes up on the
  merchant's phone. iPhones, Expo Go and web fall back to QR + code.
- **Tap mode** (`/pay`, Home → NFC Payment; tabs Pay / Receive): rule — **the phone being paid
  reads, the payer's phone presents** (NFC). Pay presents `tappi://tap/<token>` and polls
  `GET /api/taps` (→ a merchant's charge or a person). Receive is an NFC reader that posts the payer's
  token to `/api/taps/person`; the merchant's charge screen posts it to `/api/requests/:id/tap`.
  **Nearby list over Bluetooth LE** (local module `modules/tappi-nearby`, Android): Receive and an
  open charge advertise a random 8-byte id from `POST /api/nearby/beacon` (renewed every 2 min,
  `DELETE` on leave); Pay scans, resolves ids via `POST /api/nearby/resolve` and lists people and
  merchants closest first (`src/lib/nearby.ts`, ping while searching, beep per new one). After 15 s
  with nobody found Pay shows "Didn't find a phone" with Try again / Scan QR code / Enter code
  (merchant code or @username). A person's QR is `tappi://send/<username>` (route `send/[handle]`).
- **Tappi card** (Cards tab; simulated, not a bank card): one per user, spends from the wallet with
  freeze / daily limit (naira) / pay-from currency (must match the charge's). Details need the PIN.
  "Tap to pay" = phone unlock (`src/lib/unlock.ts`, if the "Unlock before tapping" pref is on; the
  Tappi PIN if the phone has no screen lock) → `POST /api/card/arm` (single-use nonce, 60 s) → the
  phone presents `tappi://card/<id>.<nonce>` → the merchant's charge screen posts it to
  `/api/requests/:id/tappi-card` and it's paid at once (no PIN, channel `tappi_card`).
  Phone-only settings (unlock, tap sound) live in `src/lib/preferences.ts`; `tapFeedback` obeys them.
  The Bitnob USD Visa card will be a separate product.
- **Accounts:** active → disabled (no incoming money) → deleting (restorable by signing in for 30
  days) → closed (personal data erased, leftover balance swept to Tappi's closed-accounts books).
- **Usernames:** checked live via `GET /api/handles/:handle` (`useHandleCheck` + `HandleHint`).
- **Leaving a flow:** use `goHome()` / `goBack(fallback)` from `@/lib/nav`, not `router.dismissTo('/')`
  or bare `router.back()` — pay and charge screens can be opened from a link with nothing beneath them.
- **Tappi AI** (centre tab-bar button → `src/app/assistant.tsx`): chat by typing or holding the mic,
  in the language picked in Profile → Tappi AI language. The server (`backend/api/.../ai/`) runs Groq
  Whisper → Groq `openai/gpt-oss-120b` with tools → Intron Sahara or Groq Orpheus voice. The reply
  text returns at once with a `speechId`; the phone waits on `/api/ai/speech/:id/ready`, then plays
  `/api/ai/speech/:id`. The AI never moves money: prepared sends become buttons that open `/approve`
  (`back=1` returns to the chat). Voice is uploaded as base64 JSON (`/api/ai/voice`), not multipart —
  React Native's multipart upload fails on some Android phones.
- **Remote testers:** `pnpm start:remote` serves the dev build through an https tunnel; set
  `EXPO_PUBLIC_API_URL` to a reachable API (the hosted one) for it. The first bundle can 504 while
  Metro compiles — open it again.
- **Builds:** the `preview`/`production` EAS profiles carry `EXPO_PUBLIC_API_URL` (`eas.json`);
  `pnpm build:preview` makes a standalone APK.
- **React Compiler gotcha:** never use non-null assertions (`x!.y`) inside callbacks in components —
  the compiler reads them during render and crashes while data is loading. Guard explicitly.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

This project uses pnpm (`pnpm-lock.yaml`).

```bash
pnpm expo install <package>  # ALWAYS use instead of pnpm add for Expo/RN packages — resolves SDK-compatible versions
pnpm start                   # dev server for the development build (pnpm start:go for Expo Go)
pnpm lint                    # lint
pnpm typecheck               # tsc --noEmit
pnpm check                   # typecheck + expo-doctor
pnpm expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
