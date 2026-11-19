# Bitnob Business API: what we'll use and how (spec notes)

Read from https://www.bitnob.dev (OpenAPI: `/api-collections/swagger/bitnob-api-v2.openapi.json`) on
2026-11-18. Not yet called for real; confirm the flagged points in sandbox first.

## Keys and auth

- One host for sandbox and live: `https://api.bitnob.com`. **The credentials decide the
  environment** (`GET /api/whoami` → `data.environment`; also the simplest signing test).
- Dashboard gives a **client ID** and **client secret** (API), and a separate **webhook secret**
  (Settings → Webhooks). Keys may be IP allow-listed (403 otherwise).
- Every request is signed (HMAC-SHA256), four headers:
  `X-Auth-Client` (client ID), `X-Auth-Timestamp` (Unix **seconds**), `X-Auth-Nonce` (16 random bytes,
  hex), `X-Auth-Signature` = hex HMAC-SHA256(key = client secret, msg = `CLIENT_ID:TIMESTAMP:NONCE:BODY`),
  BODY = the exact bytes sent ("" for GET). Clock must be within ~5 min.
- Responses: `{success, message, data, timestamp}`; errors carry a `code` (branch on it, not the text).
  500 requests/min per IP. Error codes are being renamed per company (2026-11 changelog): handle both
  `PROVIDER_ERROR`/`PROCESSING_ERROR`.

## Webhooks

- `POST {event, event_id, data}`; header `x-bitnob-signature` = hex HMAC-SHA512 of the **raw body**
  with the webhook secret; `x-bitnob-event-id` = `event_id` (dedupe on it). Order not guaranteed;
  retried ~1, 5, 15, 60 min on non-2xx (400/404/410/422/451 = not retried).
- `deposit.success` (USDT/USDC/BTC): `data {address, amount (smallest units, string), chain, currency,
  hash, reference, transaction_id, from_address}`. **No customer id: match `address` to the user.**
- `transfer.success` / `transfer.failed` (crypto sent out); `trade.completed` / `trade.failed`
  (`reference`, amounts in smallest units, types inconsistent: parse leniently);
  `payouts.withdrawal.success|failed|expired`; `virtualcard.*`.

## What we'll build on

| | Endpoint | Notes |
| --- | --- | --- |
| Customer | `POST /api/customers` | `email`, `customer_type: individual`; returns existing on duplicate |
| Deposit address | `POST /api/addresses` `{chain, customer_id, reference}` | one per user per chain; `reference` unique |
| Chains | `GET /api/addresses/supported-chains` | **sandbox: no Tron**; USDT/USDC on ethereum, polygon, solana; BTC on `bitcoin` |
| Balances | `GET /api/balances` | integer strings, smallest units |
| Send crypto | `POST /api/withdrawals` `{to_address, amount, currency, chain, reference}` | `reference` = idempotency (409 on reuse); $1 fee on top; validate first with `POST /api/addresses/validate` |
| Trade | `POST /api/trading/quotes` then `POST /api/trading/orders` | quotes expire ~10 s (prod); **crypto-pair orders don't dedupe `reference`: look up before retrying**; NGN pairs need Bitnob to enable after KYB |
| Payouts abroad | quote → `/initialize` → `/finalize` | countries/forms from `/api/payouts/supported-countries` |
| Cards | `POST /api/cards`, `/balance`, `/status`, `DELETE` | micro-units (1 USD = 1,000,000); top-up $2–$2,500, one per 120 s |

Units: balances, withdrawals, deposit webhooks = smallest-unit strings; trading and payout quotes =
major-unit decimal strings; cards = micro-units. Never floats.

## Swaps (as built, `engine/src/providers/trading.rs`)

- Naira pairs: what the user spends is the base, `side: SELL`, `quantity` = that amount (Bitnob's
  documented way to fix the amount spent). Crypto pairs as Bitnob orients them: BTC/USDT, BTC/USDC,
  USDC/USDT; buying the base is sized from `GET /api/trading/prices`.
- `POST /api/trading/quotes` → stored in `engine.trade_quotes`; `POST /api/trading/orders` with
  `quote_id` + `reference` (= our operation id). Crypto orders also send the quote's `price`.
- Unclear outcome: naira orders are re-sent with the same reference (Bitnob returns the original);
  crypto orders are looked up with `GET /api/trading/orders/{reference}`, never re-sent.
- Quotes last ~10 s in production (sandbox: 30 s naira, ~5 min crypto). NGN ₦500–₦10,000,000 per trade;
  crypto at least 1 USDC equivalent. NGN trading must be enabled by Bitnob after KYB.

## USD cards (as built, `engine/src/providers/usdcard.rs`)

- Card KYC first (`POST /api/cards/kyc`, inline `customer`, `card_program: prepaid`); BVN/NIN are
  verified instantly. Status: `GET /api/cards/kyc/{customerId}`; webhooks `virtualcard.user.kyc.*`.
  Sandbox: `POST /api/cards/kyc/{customerId}/simulate-webhook`.
- Create: `POST /api/cards` (virtual, visa, USD, `amount` micro-dollars $2–$2,500, `reference`);
  ready on `virtualcard.created.completed` (card id in `data.id`). Fund/withdraw:
  `POST /api/cards/{id}/balance`; confirmed by `virtualcard.topup.*` / `virtualcard.withdrawal.*`
  (`data.reference` = ours). Close: `DELETE /api/cards/{id}` (not in the first 24 h); refund on
  `virtualcard.terminated.refund`.
- Fees: $1 creation; top-up $1 below $100, 1% from $100. The user pays them from USDT/USDC.
- Details: `GET /api/cards/{id}/secure` returns them unencrypted **only while no card encryption key is
  registered** in Bitnob's dashboard. If one is registered, the engine refuses with a clear message
  (decryption would need RSA-OAEP-256 + AES-256-GCM).

## Still to confirm in sandbox

1. Which company balance Bitnob debits for card creation and top-ups (docs say USD in one place and
   USDC in another). If it's USDC but the user paid USDT, reconciliation shows USDT high, USDC low.
2. Whether `GET /api/cards/kyc/occupations` returns a list of `{code, name}` (the app accepts a few shapes).
3. Whether NGN trading works in sandbox, and how to fund the sandbox NGN balance (virtual-account
   simulate-deposit needs a virtual account).
