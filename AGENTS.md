This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Tappi project notes

- **Product:** Tappi SoftPOS — native mobile app (customer wallet + merchant terminal). The PRD in
  `design/` says "web app / PWA first"; that is outdated — this is a native app.
- **Blockchain:** payments/settlement run on **Stellar** (NGN + USDC balances, swaps). Not in the PRD yet.
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

## Backend (Stellar testnet)

- **Custodial, like the user's Mint project (`~/Projects/mint`):** Tappi holds wallet keys server-side,
  AES-256-GCM encrypted with `WALLET_ENCRYPTION_KEY` (`src/server/crypto.ts`). The treasury sponsors
  reserves and fee-bumps every transaction. **Testnet only.** Keys and the Stellar SDK never go in the app.
- **Where it runs:** Expo Router API routes (`src/app/api/*+api.ts`) inside `pnpm start`. Keep routes
  thin; all logic lives in `src/server/` (never import `@/server/*` from screens or components).
- **Database:** Drizzle. No `DATABASE_URL` → PGlite in `.data/pglite`, migrated on first request.
  PGlite must be loaded with Node's `require` (see `src/server/db/index.ts`), never bundled. Change
  `src/server/db/schema.ts`, then `pnpm db:generate`. `pnpm db:reset` wipes the local DB.
- **First run:** `pnpm secrets` (creates `.env.local`), then `pnpm stellar:bootstrap` (treasury, NGN
  issuer, market maker on testnet; re-runnable). Check `GET /api/health`.
- **Assets:** USDC = Circle testnet USDC; NGN = Tappi-issued test naira (asset code `NGN`).
- **App ↔ API:** screens call `api()` from `@/lib/api` and hooks in `@/lib/queries` (TanStack Query).
  Response types come from `@/lib/api-types`, which uses `import type` from `@/server/*` — the only
  allowed server import in app code. Money actions go through `/approve` (PIN checked server-side).
- **Login:** email code. On testnet `/api/auth/code` returns `devCode` and the verify screen types it
  in (`TAPPI_AUTO_CODE=false` stops that). Sign-in gating lives in `src/app/_layout.tsx` (`Stack.Protected`).
- **Payments:** Terminal → `/charge/[id]` (QR + 6-char code, NFC when available) ↔ customer
  `/pay` → `/pay/[code]` → `/approve`. Links are `tappi://pay/<CODE>`.
- **NFC:** `src/lib/nfc.ts`. Merchant broadcast = local Android module `modules/tappi-hce` (NDEF
  Type 4 tag emulation); customer read = `react-native-nfc-manager`. Both need a development build;
  in Expo Go / web the hooks report a reason and the UI falls back to QR + code.
  Links carry `?via=nfc|qr` so `/pay/[code]` records the channel. `plugins/with-nfc-pay-links.js`
  adds an NDEF_DISCOVERED filter so a tap opens the charge even when Tappi is closed (Android).
- **On-chain:** every money movement is a Stellar transaction with a `Tappi …` memo (e.g.
  `Tappi PAY AB2CD3`); the `entries` table mirrors them with `txHash`. Charges themselves (create /
  cancel / expire), PINs and account status live only in the database.
- **Accounts:** lifecycle in `src/server/account.ts` (`users.status`: active → disabled → deleting
  → closed). Disabled = no incoming money (`assertCanReceive` in `src/server/status.ts`); deleted =
  restorable by signing in for 30 days, then personal data erased, balance swept, ledger kept 5 years.
  `pnpm accounts:purge` runs the cleanup (also runs on sign-in). `ACCOUNT_RESTORE_DAYS` shortens the window.
- **Usernames:** checked live via `GET /api/handles/:handle` (`useHandleCheck` + `HandleHint`).
- **External links** (Stellar explorer): `openExternal()` from `@/lib/links` — new tab on web.
- **Testing without touching the dev DB:** `PGLITE_DIR=<copy> pnpm start --port 8090` (PGlite can only
  be opened by one process). Migrations apply on the next request, no restart needed.
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
