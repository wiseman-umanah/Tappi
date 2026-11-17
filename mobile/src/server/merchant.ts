import { randomInt } from 'node:crypto';

import { Memo, Operation } from '@stellar/stellar-sdk';
import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';
import type { Asset, Channel, RequestStatus } from './db/schema';
import { HttpError } from './errors';
import { balancesOf, getWallet, walletKeypair } from './stellar/accounts';
import { amount7, assetFor, ngn, treasuryKeypair, txUrl } from './stellar/config';
import { serialize } from './stellar/lock';
import { build, submitSponsored } from './stellar/submit';
import { assertCanReceive, assertOwnReceiving } from './status';
import { displayName, liveRate, quoteReceive, record } from './wallet';

const REQUEST_TTL_MS = 5 * 60_000;
// No 0/O/1/I so the code is easy to read out and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Testnet stand-in for the merchant's bank account. */
export const SETTLEMENT_BANK = 'GTBank •••• 7730';

type Request = typeof schema.paymentRequests.$inferSelect;
export type RequestState = RequestStatus | 'expired';

const stateOf = (r: Request): RequestState =>
  r.status === 'pending' && r.expiresAt < new Date() ? 'expired' : r.status;

const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export async function createRequest(merchant: User, amount: number, tag: string, asset: Asset = 'NGN') {
  assertOwnReceiving(merchant);
  await getWallet(merchant.id);
  const [row] = await (await db())
    .insert(schema.paymentRequests)
    .values({ code: newCode(), merchantId: merchant.id, amount, asset, tag, expiresAt: new Date(Date.now() + REQUEST_TTL_MS) })
    .returning();
  return present(row, merchant);
}

async function findRequest(idOrCode: string) {
  const d = await db();
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrCode);
  const row = await d.query.paymentRequests.findFirst({
    where: isUuid ? eq(schema.paymentRequests.id, idOrCode) : eq(schema.paymentRequests.code, idOrCode.toUpperCase()),
  });
  if (!row) throw new HttpError(404, 'No payment found for that code.');
  return row;
}

function present(r: Request, merchant: User, tappedBy?: User | null) {
  return {
    id: r.id,
    code: r.code,
    amount: r.amount,
    /** The currency charged (and received by the merchant). */
    asset: r.asset,
    tag: r.tag,
    state: stateOf(r),
    expiresAt: r.expiresAt.toISOString(),
    /** What the merchant's QR code carries. */
    link: `tappi://pay/${r.code}`,
    merchant: { name: displayName(merchant), handle: merchant.handle, gender: merchant.gender },
    /** Merchant only: the customer whose phone was tapped, while they approve with their PIN. */
    tapped: tappedBy ? displayName(tappedBy) : null,
    channel: r.channel,
    cardBrand: r.cardBrand,
    tx: r.txHash ? txUrl(r.txHash) : null,
  };
}

export async function getRequest(viewer: User, idOrCode: string) {
  const d = await db();
  const row = await findRequest(idOrCode);
  const merchant = await d.query.users.findFirst({ where: eq(schema.users.id, row.merchantId) });
  const tappedBy =
    viewer.id === row.merchantId && row.tappedBy && row.status === 'pending'
      ? await d.query.users.findFirst({ where: eq(schema.users.id, row.tappedBy) })
      : null;
  return present(row, merchant!, tappedBy);
}

/**
 * The customer pays a pending request from their NGN or USDC balance. The merchant always receives
 * exactly what they charged; paying from the other currency converts on the way (path payment).
 */
export async function payRequest(payer: User, idOrCode: string, payAsset: Asset, channel: Channel) {
  const d = await db();
  const row = await findRequest(idOrCode);
  if (row.merchantId === payer.id) throw new HttpError(400, "You can't pay your own charge.");
  const state = stateOf(row);
  if (state !== 'pending') throw new HttpError(409, state === 'expired' ? 'This charge has expired.' : 'This charge is no longer open.');
  const owner = await d.query.users.findFirst({ where: eq(schema.users.id, row.merchantId) });
  assertCanReceive(owner ?? { status: 'closed' }, 'This merchant');

  // Claim the request first so two phones can't both pay it.
  const [claimed] = await d
    .update(schema.paymentRequests)
    .set({ status: 'paid', payerId: payer.id, payAsset, channel, paidAt: new Date() })
    .where(and(eq(schema.paymentRequests.id, row.id), eq(schema.paymentRequests.status, 'pending')))
    .returning();
  if (!claimed) throw new HttpError(409, 'This charge is no longer open.');

  try {
    const [from, merchantWallet, merchant] = await Promise.all([
      walletKeypair(payer.id),
      getWallet(row.merchantId),
      d.query.users.findFirst({ where: eq(schema.users.id, row.merchantId) }),
    ]);
    let spent = row.amount;
    const op =
      payAsset === row.asset
        ? Operation.payment({ destination: merchantWallet.publicKey, asset: assetFor(row.asset), amount: amount7(row.amount) })
        : await (async () => {
            // The merchant receives the exact amount charged; the payer's side converts at the live rate.
            const q = await quoteReceive(payAsset, row.amount);
            spent = q.cost;
            return Operation.pathPaymentStrictReceive({
              sendAsset: assetFor(payAsset),
              sendMax: amount7(q.cost * 1.01),
              destination: merchantWallet.publicKey,
              destAsset: assetFor(row.asset),
              destAmount: amount7(row.amount),
              path: [],
            });
          })();
    const result = await serialize(from.publicKey(), async () => submitSponsored(await build(from.publicKey(), [op], Memo.text(`Tappi PAY ${row.code}`)), [from]));
    await d.update(schema.paymentRequests).set({ txHash: result.hash }).where(eq(schema.paymentRequests.id, row.id));
    await record(
      { userId: payer.id, kind: 'payment_out', title: displayName(merchant!), tag: row.tag, asset: payAsset, amount: -spent, channel, requestId: row.id, txHash: result.hash },
      { userId: row.merchantId, kind: 'payment_in', title: displayName(payer), tag: row.tag, asset: row.asset, amount: row.amount, channel, requestId: row.id, txHash: result.hash },
    );
    return { tx: txUrl(result.hash), amount: row.amount, asset: row.asset, spent, payAsset, merchant: displayName(merchant!) };
  } catch (error) {
    await d
      .update(schema.paymentRequests)
      .set({ status: 'pending', payerId: null, payAsset: null, channel: null, paidAt: null })
      .where(eq(schema.paymentRequests.id, row.id));
    throw error;
  }
}

/** Card brands the merchant's reader recognises (from the card's payment application ID). */
export const CARD_BRANDS = ['Visa', 'Mastercard', 'Verve', 'American Express', 'Discover', 'UnionPay', 'JCB', 'Card'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

/**
 * A bank card tapped the merchant's phone. Reading the card is real; charging it needs a licensed
 * acquirer, so on testnet the treasury pays the merchant instead (`Tappi CARD <code>` on-chain).
 */
export async function payByCard(merchant: User, id: string, brand: CardBrand) {
  assertOwnReceiving(merchant);
  const d = await db();
  const [claimed] = await d
    .update(schema.paymentRequests)
    .set({ status: 'paid', channel: 'card', cardBrand: brand, paidAt: new Date() })
    .where(
      and(
        eq(schema.paymentRequests.id, id),
        eq(schema.paymentRequests.merchantId, merchant.id),
        eq(schema.paymentRequests.status, 'pending'),
        gt(schema.paymentRequests.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimed) throw new HttpError(409, 'This charge is no longer open.');
  try {
    const wallet = await getWallet(merchant.id);
    const treasury = treasuryKeypair();
    const result = await serialize(treasury.publicKey(), async () =>
      submitSponsored(
        await build(treasury.publicKey(), [
          Operation.payment({ destination: wallet.publicKey, asset: assetFor(claimed.asset), amount: amount7(claimed.amount) }),
        ], Memo.text(`Tappi CARD ${claimed.code}`)),
        [treasury],
      ),
    );
    await d.update(schema.paymentRequests).set({ txHash: result.hash }).where(eq(schema.paymentRequests.id, claimed.id));
    await record({
      userId: merchant.id,
      kind: 'payment_in',
      title: `${brand} card`,
      tag: claimed.tag,
      asset: claimed.asset,
      amount: claimed.amount,
      channel: 'card',
      requestId: claimed.id,
      txHash: result.hash,
    });
    return { tx: txUrl(result.hash), amount: claimed.amount, asset: claimed.asset, brand };
  } catch (error) {
    await d
      .update(schema.paymentRequests)
      .set({ status: 'pending', channel: null, cardBrand: null, paidAt: null })
      .where(eq(schema.paymentRequests.id, claimed.id));
    throw error;
  }
}

export async function cancelRequest(merchant: User, id: string) {
  await (await db())
    .update(schema.paymentRequests)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(schema.paymentRequests.id, id),
        eq(schema.paymentRequests.merchantId, merchant.id),
        eq(schema.paymentRequests.status, 'pending'),
      ),
    );
}

/** Sends a completed payment back to the customer, in the currency it was charged in. */
export async function refund(merchant: User, id: string) {
  const d = await db();
  const [row] = await d
    .update(schema.paymentRequests)
    .set({ status: 'refunded' })
    .where(
      and(
        eq(schema.paymentRequests.id, id),
        eq(schema.paymentRequests.merchantId, merchant.id),
        eq(schema.paymentRequests.status, 'paid'),
      ),
    )
    .returning();
  if (row?.channel === 'card') {
    await d.update(schema.paymentRequests).set({ status: 'paid' }).where(eq(schema.paymentRequests.id, row.id));
    throw new HttpError(409, 'Card payments are refunded to the card by the bank. That needs a card acquirer, so not on testnet.');
  }
  if (!row || !row.payerId) throw new HttpError(409, 'Only completed payments can be refunded.');
  try {
    // Refunds return the customer's own money, so a disabled account still gets them back.
    const customer = await d.query.users.findFirst({ where: eq(schema.users.id, row.payerId) });
    if (customer?.status === 'closed') throw new HttpError(409, 'This customer has left Tappi, so it can’t be refunded.');
    const [from, payerWallet, payer] = await Promise.all([
      walletKeypair(merchant.id),
      getWallet(row.payerId),
      d.query.users.findFirst({ where: eq(schema.users.id, row.payerId) }),
    ]);
    const result = await serialize(from.publicKey(), async () =>
      submitSponsored(
        await build(from.publicKey(), [
          Operation.payment({ destination: payerWallet.publicKey, asset: assetFor(row.asset), amount: amount7(row.amount) }),
        ], Memo.text(`Tappi REFUND ${row.code}`)),
        [from],
      ),
    );
    await d.update(schema.paymentRequests).set({ refundTxHash: result.hash }).where(eq(schema.paymentRequests.id, row.id));
    await record(
      { userId: merchant.id, kind: 'refund_out', title: `Refund to ${displayName(payer!)}`, tag: row.tag, asset: row.asset, amount: -row.amount, requestId: row.id, txHash: result.hash },
      { userId: row.payerId, kind: 'refund_in', title: `Refund from ${displayName(merchant)}`, tag: row.tag, asset: row.asset, amount: row.amount, requestId: row.id, txHash: result.hash },
    );
    return { tx: txUrl(result.hash) };
  } catch (error) {
    await d.update(schema.paymentRequests).set({ status: 'paid' }).where(eq(schema.paymentRequests.id, row.id));
    throw error;
  }
}

// ---------------- Merchant dashboard ----------------

const STATUS_LABEL = { paid: 'Completed', refunded: 'Refunded', cancelled: 'Failed', expired: 'Failed' } as const;

async function payoutBalance(merchantId: string) {
  const d = await db();
  const [sales] = await d
    .select({ total: sql<string>`coalesce(sum(${schema.paymentRequests.amount}), 0)` })
    .from(schema.paymentRequests)
    .where(
      and(
        eq(schema.paymentRequests.merchantId, merchantId),
        eq(schema.paymentRequests.status, 'paid'),
        // Bank settlement is in naira; USDC sales stay in the merchant's USDC balance.
        eq(schema.paymentRequests.asset, 'NGN'),
      ),
    );
  const [settled] = await d
    .select({ total: sql<string>`coalesce(sum(-${schema.entries.amount}), 0)` })
    .from(schema.entries)
    .where(and(eq(schema.entries.userId, merchantId), eq(schema.entries.kind, 'settlement')));
  return Math.max(0, Number(sales.total) - Number(settled.total));
}

export async function dashboard(merchant: User) {
  const d = await db();
  // Totals and the chart are in naira; USDC sales count at the live rate.
  const rate = await liveRate().catch(() => Number(process.env.NGN_PER_USDC || 1569));
  const inNaira = (r: Request) => (r.asset === 'USDC' ? r.amount * rate : r.amount);
  const rows = await d.query.paymentRequests.findMany({
    where: and(
      eq(schema.paymentRequests.merchantId, merchant.id),
      inArray(schema.paymentRequests.status, ['paid', 'refunded', 'cancelled', 'pending']),
    ),
    orderBy: desc(schema.paymentRequests.createdAt),
    limit: 100,
  });
  const payerIds = [...new Set(rows.map((r) => r.payerId).filter((id): id is string => Boolean(id)))];
  const payers = payerIds.length
    ? await d.query.users.findMany({ where: inArray(schema.users.id, payerIds) })
    : [];
  const payerName = new Map(payers.map((p) => [p.id, displayName(p)]));

  const payments = rows
    .map((r) => ({ r, state: stateOf(r) }))
    .filter(({ state }) => state !== 'pending')
    .map(({ r, state }) => ({
      id: r.id,
      amount: r.amount,
      asset: r.asset,
      tag: r.tag,
      status: STATUS_LABEL[state as keyof typeof STATUS_LABEL],
      payer: r.payerId
        ? (payerName.get(r.payerId) ?? 'Tappi user')
        : r.cardBrand
          ? `${r.cardBrand} card`
          : state === 'cancelled'
            ? 'Cancelled'
            : 'Not paid',
      channel: r.channel,
      at: (r.paidAt ?? r.createdAt).toISOString(),
      tx: r.txHash ? txUrl(r.txHash) : null,
    }));

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const completedToday = rows.filter((r) => r.status === 'paid' && r.paidAt && r.paidAt >= startOfDay);

  const weekStart = new Date(startOfDay.getTime() - 6 * 86_400_000);
  const week = await d.query.paymentRequests.findMany({
    where: and(
      eq(schema.paymentRequests.merchantId, merchant.id),
      eq(schema.paymentRequests.status, 'paid'),
      gte(schema.paymentRequests.paidAt, weekStart),
    ),
  });
  const weekly = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(weekStart.getTime() + i * 86_400_000);
    const next = day.getTime() + 86_400_000;
    const amount = week
      .filter((r) => r.paidAt && r.paidAt.getTime() >= day.getTime() && r.paidAt.getTime() < next)
      .reduce((s, r) => s + inNaira(r), 0);
    return { day: i === 6 ? 'Today' : day.toLocaleDateString('en-US', { weekday: 'short' }), amount };
  });

  return {
    payments,
    /** Naira, with USDC sales at the live rate. */
    todayVolume: completedToday.reduce((s, r) => s + inNaira(r), 0),
    todayUsdc: completedToday.filter((r) => r.asset === 'USDC').reduce((s, r) => s + r.amount, 0),
    todayTaps: completedToday.length,
    payoutBalance: await payoutBalance(merchant.id),
    settlementBank: SETTLEMENT_BANK,
    weekly,
  };
}

/** Testnet stand-in for a bank payout: the payout balance goes back to the treasury. */
export async function settle(merchant: User) {
  const keypair = await walletKeypair(merchant.id);
  const available = Math.min(await payoutBalance(merchant.id), (await balancesOf(keypair.publicKey()))?.NGN ?? 0);
  if (available < 1) throw new HttpError(400, 'Nothing to settle yet.');
  const result = await serialize(keypair.publicKey(), async () =>
    submitSponsored(
      await build(keypair.publicKey(), [
        Operation.payment({ destination: treasuryKeypair().publicKey(), asset: ngn(), amount: amount7(available) }),
      ], Memo.text('Tappi SETTLEMENT')),
      [keypair],
    ),
  );
  await record({
    userId: merchant.id,
    kind: 'settlement',
    title: `Settled to ${SETTLEMENT_BANK}`,
    tag: 'Settlement',
    asset: 'NGN',
    amount: -available,
    txHash: result.hash,
  });
  return { amount: available, bank: SETTLEMENT_BANK, tx: txUrl(result.hash) };
}
