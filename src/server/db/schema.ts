import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const money = (name: string) => numeric(name, { precision: 20, scale: 7, mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export type Gender = 'female' | 'male';
/**
 * active    → normal
 * disabled  → the user turned off incoming money (no sends, charges or deposits to them)
 * deleting  → deleted by the user; restorable by signing in until `deleteAfter`
 * closed    → personal data erased (the Pollar wallet stays the user's); ledger kept until `retainUntil`
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
  /** Language Tappi AI speaks and listens in (a code from src/server/ai/languages.ts). */
  language: text('language').notNull().default('en'),
  /** The Pollar user this account signs in as (Pollar holds the wallet; see src/server/pollar.ts). */
  pollarUserId: text('pollar_user_id').unique(),
  /** When the welcome money was paid, so it's paid once. */
  welcomedAt: timestamp('welcomed_at', { withTimezone: true }),
  deleteAfter: timestamp('delete_after', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  retainUntil: timestamp('retain_until', { withTimezone: true }),
  createdAt: createdAt(),
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
  /** The Pollar wallet's address. Its key is Pollar's and the user's: Tappi never has it. */
  publicKey: text('public_key').notNull().unique(),
  createdAt: createdAt(),
});

export type Asset = 'NGN' | 'USDC';
export type RequestStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';
/**
 * nfc = customer's phone tapped the merchant's; card = a bank card tapped it (testnet: simulated);
 * nearby = picked from the Bluetooth list of phones around; tappi_card = the customer's Tappi card
 * (their phone, unlocked, held to the merchant's).
 */
export type Channel = 'nfc' | 'qr' | 'code' | 'card' | 'nearby' | 'tappi_card';

// A merchant's charge from the Terminal. Paid by a tapped phone or card, QR or short code.
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
    /** What the merchant charges in, and receives exactly. The customer may pay from either balance. */
    asset: text('asset').$type<Asset>().notNull().default('NGN'),
    tag: text('tag').notNull(),
    status: text('status').$type<RequestStatus>().notNull().default('pending'),
    payerId: uuid('payer_id').references(() => users.id, { onDelete: 'set null' }),
    payAsset: text('pay_asset').$type<Asset>(),
    channel: text('channel').$type<Channel>(),
    /** The customer whose phone touched the merchant's; they still approve with their PIN. */
    tappedBy: uuid('tapped_by').references(() => users.id, { onDelete: 'set null' }),
    tappedAt: timestamp('tapped_at', { withTimezone: true }),
    /** Scheme of the card that paid (Visa, Mastercard, Verve…), for card payments. */
    cardBrand: text('card_brand'),
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

export type AiRole = 'user' | 'assistant';

// Tappi AI chats. Each one is its own thread the user can come back to.
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The first thing the user said, shortened. */
    title: text('title').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_conversations_user_idx').on(t.userId, t.updatedAt)],
);

// Messages in a chat. Only the last few turns go back to the model.
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<AiRole>().notNull(),
    content: text('content').notNull(),
    /** Assistant only: actions it prepared (send, swap…), shown as buttons. JSON. */
    actions: text('actions'),
    /** User only: true when the message was spoken (the content is the transcript). */
    spoken: boolean('spoken').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

// Bluetooth beacons: a phone in tap mode (Receive, or a merchant with a charge open) announces a
// random id; phones around ask the server who it is. Ids are short-lived and replaced often.
export const nearbyBeacons = pgTable(
  'nearby_beacons',
  {
    /** 8 random bytes as hex — what the phone advertises. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set for a merchant's open charge: picking them opens that charge. */
    requestId: uuid('request_id').references(() => paymentRequests.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('nearby_beacons_user_idx').on(t.userId)],
);

// Phone-to-phone taps between people: the payee's phone (in Receive) read the payer's phone,
// so the payer's Pay screen opens Send with the payee filled in.
export const personTaps = pgTable(
  'person_taps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    payeeId: uuid('payee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('person_taps_payer_idx').on(t.payerId, t.createdAt)],
);

// Each user's Tappi card (testnet: simulated — a real card needs a licensed issuer). Spending
// comes out of the wallet like any Tappi payment. The phone is the card: "Tap to pay" arms it for
// a minute with a single-use nonce, and the merchant's phone reads it over NFC.
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Test number (Luhn-valid, not a real card range). */
  number: text('number').notNull(),
  expMonth: integer('exp_month').notNull(),
  expYear: integer('exp_year').notNull(),
  cvv: text('cvv').notNull(),
  frozen: boolean('frozen').notNull().default(false),
  /** Most the card may spend per day, in naira (USDC spends count at the live rate). */
  dailyLimit: money('daily_limit').notNull().default(100_000),
  /** Which balance pays; a charge in the other currency is converted. */
  fundingAsset: text('funding_asset').$type<Asset>().notNull().default('NGN'),
  /** Set by "Tap to pay"; cleared when a merchant uses it or it runs out. */
  armedNonce: text('armed_nonce'),
  armedUntil: timestamp('armed_until', { withTimezone: true }),
  createdAt: createdAt(),
});

/** trust = the wallet's NGN and USDC trustlines, signed once during setup. */
export type UserTxKind = 'pay' | 'send' | 'swap' | 'refund' | 'settle' | 'trust';

// A transaction Tappi built for a user to sign on their phone (through Pollar). The server keeps
// the exact transaction; a signed copy is only accepted if it hashes the same, so the phone can't
// change what it pays. Used once, then deleted; unsigned ones expire with the transaction (2 min).
export const userTxs = pgTable(
  'user_txs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UserTxKind>().notNull(),
    /** Unsigned transaction envelope (base64 XDR), source = the user's wallet. */
    xdr: text('xdr').notNull(),
    /** Hex hash of that transaction: what the signature must cover. */
    hash: text('hash').notNull(),
    /** What to record once it lands (amounts, the charge it pays, …). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** A Tappi card charge waiting for the card holder's phone to sign. */
    requestId: uuid('request_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('user_txs_user_idx').on(t.userId, t.createdAt)],
);
