import { randomBytes, randomInt } from 'node:crypto';

import { and, desc, eq, gt, gte } from 'drizzle-orm';

import type { User } from './auth';
import { verifyPin } from './auth';
import { db, schema } from './db';
import type { Asset } from './db/schema';
import { HttpError } from './errors';
import { preparePay } from './merchant';
import { findWallet } from './stellar/accounts';
import { pendingCardTx } from './stellar/user-tx';
import { displayName, liveRate } from './wallet';

/**
 * The Tappi card (testnet: simulated — issuing a real card needs a licensed issuer). It spends
 * from the wallet like any Tappi payment, with card rules on top: freeze, a daily limit, and which
 * balance pays.
 *
 * Tapping: the phone is the card. "Tap to pay" (after the phone's unlock, if the user wants that)
 * arms the card for a minute with a random single-use nonce; the phone presents
 * `tappi://card/<cardId>.<nonce>` over NFC; the merchant's charge screen reads it and Tappi builds
 * the payment for the card holder. Their phone, still showing Tap to pay, signs it through Pollar
 * by itself (it polls GET /api/card) — the unlock was the approval, like a contactless card.
 */
const ARM_MS = 60_000;
/** Not a real card range: 88 is unassigned to payment networks. */
const TEST_PREFIX = '889912';
export const DAILY_LIMITS = [20_000, 50_000, 100_000, 200_000, 500_000] as const;
const CHANNEL = 'tappi_card';

type Card = typeof schema.cards.$inferSelect;

function luhnDigit(partial: string) {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

function newNumber() {
  const body = TEST_PREFIX + Array.from({ length: 9 }, () => randomInt(10)).join('');
  return body + luhnDigit(body);
}

async function ownCard(user: User): Promise<Card> {
  if (!(await findWallet(user.id))) throw new HttpError(409, 'Finish your profile to get your Tappi card.');
  const d = await db();
  const existing = await d.query.cards.findFirst({ where: eq(schema.cards.userId, user.id) });
  if (existing) return existing;
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 3);
  const [created] = await d
    .insert(schema.cards)
    .values({
      userId: user.id,
      number: newNumber(),
      expMonth: expiry.getMonth() + 1,
      expYear: expiry.getFullYear(),
      cvv: String(randomInt(1000)).padStart(3, '0'),
    })
    .onConflictDoNothing()
    .returning();
  // Lost a race with another request creating it: read theirs.
  return created ?? (await d.query.cards.findFirst({ where: eq(schema.cards.userId, user.id) }))!;
}

/** Today's card spending in naira (USDC spends at the live rate). */
async function spentToday(userId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await (await db()).query.entries.findMany({
    where: and(
      eq(schema.entries.userId, userId),
      eq(schema.entries.kind, 'payment_out'),
      eq(schema.entries.channel, CHANNEL),
      gte(schema.entries.createdAt, start),
    ),
  });
  if (!rows.length) return 0;
  const rate = rows.some((r) => r.asset === 'USDC') ? await liveRate() : 1;
  return rows.reduce((sum, r) => sum + -r.amount * (r.asset === 'USDC' ? rate : 1), 0);
}

const expiry = (c: Card) => `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`;

/** The card as the Cards screen shows it: number masked. */
export async function getCard(user: User) {
  const card = await ownCard(user);
  const d = await db();
  const armed = card.armedNonce && card.armedUntil && card.armedUntil > new Date() ? card.armedUntil.toISOString() : null;
  // The latest card payment from the last two minutes, so the screen can say it went through.
  const last = await d.query.entries.findFirst({
    where: and(
      eq(schema.entries.userId, user.id),
      eq(schema.entries.channel, CHANNEL),
      eq(schema.entries.kind, 'payment_out'),
      gt(schema.entries.createdAt, new Date(Date.now() - 2 * 60_000)),
    ),
    orderBy: desc(schema.entries.createdAt),
  });
  const pending = await pendingCardTx(user);
  return {
    /** A merchant read the card: the phone signs this through Pollar and posts it to /api/tx/:id. */
    pendingPayment: pending ? { id: pending.id, xdr: pending.xdr, expiresAt: pending.expiresAt.toISOString() } : null,
    last4: card.number.slice(-4),
    expiry: expiry(card),
    holder: user.name ?? (user.handle ? `@${user.handle}` : 'Tappi user'),
    frozen: card.frozen,
    dailyLimit: card.dailyLimit,
    fundingAsset: card.fundingAsset,
    spentToday: Math.round(await spentToday(user.id)),
    limits: DAILY_LIMITS,
    armedUntil: armed,
    lastPayment: last ? { id: last.id, merchant: last.title, asset: last.asset, amount: -last.amount, at: last.createdAt.toISOString() } : null,
  };
}

/** Full number, expiry and CVV — only after the PIN. */
export async function cardDetails(user: User, pin: string) {
  await verifyPin(user, pin);
  const card = await ownCard(user);
  return { number: card.number.replace(/(\d{4})(?=\d)/g, '$1 '), expiry: expiry(card), cvv: card.cvv };
}

export async function updateCard(user: User, input: { frozen?: boolean; dailyLimit?: number; fundingAsset?: Asset }) {
  const card = await ownCard(user);
  await (await db())
    .update(schema.cards)
    // Freezing also disarms a card that's waiting for a tap.
    .set({ ...input, ...(input.frozen ? { armedNonce: null, armedUntil: null } : {}) })
    .where(eq(schema.cards.id, card.id));
  return getCard(user);
}

/** "Tap to pay": the card can be read by one merchant in the next minute. `pin` when the phone has no lock. */
export async function armCard(user: User, pin?: string) {
  if (pin) await verifyPin(user, pin);
  if (user.status !== 'active' && user.status !== 'disabled') throw new HttpError(403, 'This account is being deleted.');
  const card = await ownCard(user);
  if (card.frozen) throw new HttpError(409, 'Your card is frozen. Unfreeze it to pay.');
  const nonce = randomBytes(16).toString('base64url');
  const armedUntil = new Date(Date.now() + ARM_MS);
  await (await db()).update(schema.cards).set({ armedNonce: nonce, armedUntil }).where(eq(schema.cards.id, card.id));
  return { link: `tappi://card/${card.id}.${nonce}`, armedUntil: armedUntil.toISOString() };
}

export async function disarmCard(user: User) {
  await (await db())
    .update(schema.cards)
    .set({ armedNonce: null, armedUntil: null })
    .where(eq(schema.cards.userId, user.id));
  return { ok: true };
}

/**
 * The merchant's phone read a Tappi card: build the payment from the card holder's wallet. Their
 * phone signs it within a few seconds; the merchant's charge screen sees the charge turn paid.
 */
export async function payWithCard(merchant: User, requestId: string, token: string) {
  const [cardId, nonce] = token.split('.');
  if (!cardId || !nonce || !/^[0-9a-f-]{36}$/i.test(cardId)) throw new HttpError(400, "That isn't a Tappi card.");
  const d = await db();
  // Use the nonce up first: one tap pays once, even if it's read twice.
  const [card] = await d
    .update(schema.cards)
    .set({ armedNonce: null, armedUntil: null })
    .where(and(eq(schema.cards.id, cardId), eq(schema.cards.armedNonce, nonce), gt(schema.cards.armedUntil, new Date())))
    .returning();
  if (!card) throw new HttpError(410, 'That card tap ran out. Ask them to press Tap to pay again.');
  if (card.frozen) throw new HttpError(409, 'That card is frozen.');
  if (card.userId === merchant.id) throw new HttpError(400, "That's your own card.");

  const holder = await d.query.users.findFirst({ where: eq(schema.users.id, card.userId) });
  if (!holder || holder.status === 'deleting' || holder.status === 'closed') throw new HttpError(404, 'That card is no longer active.');
  const charge = await d.query.paymentRequests.findFirst({
    where: and(eq(schema.paymentRequests.id, requestId), eq(schema.paymentRequests.merchantId, merchant.id)),
  });
  if (!charge) throw new HttpError(404, 'No such charge.');

  const inNaira = charge.asset === 'USDC' ? charge.amount * (await liveRate()) : charge.amount;
  if ((await spentToday(holder.id)) + inNaira > card.dailyLimit + 0.005) {
    throw new HttpError(402, 'Over the card’s daily limit. They can raise it on the Cards screen, or pay with Pay.');
  }
  await preparePay(holder, charge.id, card.fundingAsset, CHANNEL);
  return { waiting: true as const, holder: displayName(holder) };
}
