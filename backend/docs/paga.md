# Paga Engine: what we use and how (spec notes)

Read from https://developer-docs.paga.com on 2026-11-18. Where the docs are silent or ambiguous it
says so; confirm those points with Paga (business.support@paga.com) before going live.

## Accounts and keys

- Sandbox and live are **separate Paga business accounts** with separate keys; keys from one don't
  work in the other. Sandbox: https://beta-business.paga.com/partner/register (needs approval, ~24 h,
  email business.support@paga.com with the account name and number). Live: business.paga.com (KYC).
- Dashboard → Developer Tools → API Keys: **public key**, **secret key**, **hash key**.
- **Payouts (Business API) only work from allow-listed IP addresses** (HTTP 403 otherwise). How to
  register IPs isn't documented: ask Paga. A laptop on home internet usually has a changing IP, so
  test payouts from the server.

| | Sandbox | Live | Auth |
| --- | --- | --- | --- |
| Business API (payouts, balance) | `https://beta.mypaga.com` | `https://www.mypaga.com` | headers `principal` (public key), `credentials` (secret key), `hash` |
| Collect API (subsidiary accounts) | `https://beta-collect.paga.com` | `https://collect.paga.com` | `Authorization: Basic base64(public:secret)` + `hash` |

**Hash** = lowercase hex SHA-512 of the listed field values concatenated with no separator, then the
hash key. Missing fields count as "".

## Customer account numbers (Subsidiary Accounts, Collect API)

- `POST /subsidiary-accounts`. Hash: `referenceNumber + accountReference + iifiNumber +
  autoSweep.bankPublicId + autoSweep.destination + autoSweep.accountNumber + callbackUrl + hashKey`.
  Body: `referenceNumber`, `accountReference` (11–30 chars, permanent), `accountName`, optional
  `firstName`, `lastName`, `phoneNumber`, `email`, `iifiNumber` (BVN/NIN), `callbackUrl`,
  `autoSweep {destination, bankPublicId, accountNumber}`. Returns `statusCode` ("0" = ok, "102" =
  duplicate reference), `accountNumber` (10-digit NUBAN).
- **We use `autoSweep.destination = "VIRTUAL_ACCOUNT"`**: deposits go straight to Tappi's Paga
  business balance; the engine's ledger is the record of what each user holds.
- `GET /subsidiary-accounts/{accountReference}?referenceNumber=…`, hash `referenceNumber + accountReference + hashKey`.
- **Funding webhook** (`POST` to the account's `callbackUrl`, no auth): body `transactionReference`,
  `transactionDate`, `amount` (naira, e.g. 5000), `clearingFeeAmount`, `accountNumber`, `payerDetails`…
  Header `x-paga-hash-v3` = SHA-512(`transactionReference + transactionDate + amount + accountNumber +
  timestamp + hashKey`). `timestamp` isn't in the documented body (ask Paga);
  `x-paga-hash-v3-parameters`, when sent, lists the fields used. Reply `200 {"status": "SUCCESS"}`.

## Payouts to banks (Business API, `POST /paga-webservices/business-rest/secured/<op>`)

Success is `responseCode` 0; HTTP 200 alone isn't success. Amounts are naira strings (`"5000.00"`).

- `getBanks`: hash `referenceNumber + hashKey` → `banks[] {uuid, name, sortCode}`. Cache it.
- `validateDepositToBank`: hash `referenceNumber + amount + destinationBankUUID +
  destinationBankAccountNumber + hashKey` → `destinationAccountHolderNameAtBank`, `fee`, `vat`.
- `depositToBank`: same hash; body adds `statusCallbackUrl`, `remarks`. Paid from the business balance.
- `transactionStatus`: hash `referenceNumber + hashKey`; last 48 h only.
- `accountBalance`: hash `referenceNumber + hashKey` → `availableBalance`.
- **Never resend on a timeout or error**: ask `transactionStatus` with the same reference; treat
  unknown codes as pending. `105` = duplicate reference (already logged). Final failures include
  `4`, `103`, `107`, `114`, `115`, `136`, `137`, `138`, `139` (insufficient balance). `3` = pending.
- **Payout webhook** (`POST` to `statusCallbackUrl`, no auth): header `x-paga-hash` =
  SHA-512(`referenceNumber + transactionDate + transactionId + amount + sessionId + hashKey`), values
  exactly as received. Retried until we answer `200 {"status": "SUCCESS"}`.

## Open questions for Paga

1. Where `timestamp` in the funding-webhook hash comes from.
2. How to allow-list our server's IP.
3. Amount units (all examples are naira) and who bears `clearingFeeAmount`.
4. Whether a duplicate create (`102`) returns the original account.
