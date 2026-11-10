import { index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const money = (name: string) => numeric(name, { precision: 20, scale: 7, mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export type Gender = 'female' | 'male';
/**
 * active    → normal
 * disabled  → the user turned off incoming money (no sends, charges or deposits to them)
 * deleting  → deleted by the user; restorable by signing in until `deleteAfter`
 * closed    → personal data erased, balance swept; the ledger is kept until `retainUntil`
 */
export type AccountStatus = 'active' | 'disabled' | 'deleting' | 'closed';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Null once the account is closed, so the address can sign up again. */
  email: text('email').unique(),
  /** HMAC of the email, kept after closing so records can still be matched for compliance. */
  emailHash: text('email_hash'),
  handle: text('handle').unique(),
  name: text('name'),
  gender: text('gender').$type<Gender>(),
  pinHash: text('pin_hash'),
  pinFailures: integer('pin_failures').notNull().default(0),
  pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
  status: text('status').$type<AccountStatus>().notNull().default('active'),
  deleteAfter: timestamp('delete_after', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  retainUntil: timestamp('retain_until', { withTimezone: true }),
  createdAt: createdAt(),
});

// Login codes. Only an HMAC of the code is stored.
export const loginCodes = pgTable('login_codes', {
  email: text('email').primaryKey(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// Bearer sessions. Only an HMAC of the token is stored.
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// One custodial Stellar wallet per user. The secret is encrypted (see src/server/crypto.ts).
export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull().unique(),
  /** Dropped once a closed account's balance has been swept. */
  encryptedSecret: text('encrypted_secret'),
  createdAt: createdAt(),
});

export type Asset = 'NGN' | 'USDC';
export type RequestStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';
export type Channel = 'nfc' | 'qr' | 'code';

// A merchant's charge from the Terminal. The customer's phone pays it by NFC, QR or short code.
export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short code a customer can type when tapping and scanning aren't possible. */
    code: text('code').notNull().unique(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: money('amount').notNull(),
    tag: text('tag').notNull(),
    status: text('status').$type<RequestStatus>().notNull().default('pending'),
    payerId: uuid('payer_id').references(() => users.id, { onDelete: 'set null' }),
    payAsset: text('pay_asset').$type<Asset>(),
    channel: text('channel').$type<Channel>(),
    txHash: text('tx_hash'),
    refundTxHash: text('refund_tx_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('payment_requests_merchant_idx').on(t.merchantId, t.createdAt)],
);

export type EntryKind = 'deposit' | 'payment_in' | 'payment_out' | 'swap' | 'refund_in' | 'refund_out' | 'settlement' | 'closure';

/**
 * Per-user ledger of everything that moved on-chain, written when the transaction succeeds.
 * Amounts are signed from the user's point of view; swaps also record what came in.
 */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<EntryKind>().notNull(),
    title: text('title').notNull(),
    tag: text('tag').notNull(),
    asset: text('asset').$type<Asset>().notNull(),
    amount: money('amount').notNull(),
    assetIn: text('asset_in').$type<Asset>(),
    amountIn: money('amount_in'),
    channel: text('channel'),
    requestId: uuid('request_id').references(() => paymentRequests.id, { onDelete: 'set null' }),
    txHash: text('tx_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('entries_user_idx').on(t.userId, t.createdAt)],
);
