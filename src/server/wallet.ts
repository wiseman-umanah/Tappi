import { Memo, Operation } from '@stellar/stellar-sdk';
import { and, desc, eq, gt } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';
import type { Asset, Gender } from './db/schema';
import { HttpError } from './errors';
import { HANDLE_PATTERN, isHandleTaken, normalizeHandle } from './handles';
import { balancesOf, findWallet, getWallet, payWelcomeGrant, walletSetup, WELCOME_GRANT } from './stellar/accounts';
import { accountUrl, amount7, assetFor, horizon, treasuryKeypair, txUrl } from './stellar/config';
import { serialize } from './stellar/lock';
import { build, submitSponsored } from './stellar/submit';
import { type Handler, prepareUserTx } from './stellar/user-tx';
import { assertCanReceive, assertOwnReceiving, RESTORE_DAYS } from './status';

export const displayName = (u: Pick<User, 'name' | 'handle' | 'email'>) =>
  u.name ?? (u.handle ? `@${u.handle}` : (u.email ?? 'Former Tappi user'));

export type NewEntry = Omit<typeof schema.entries.$inferInsert, 'id' | 'createdAt'>;

export async function record(...rows: NewEntry[]) {
  if (rows.length) await (await db()).insert(schema.entries).values(rows);
}

// ---------------- Profile & wallet ----------------

export async function me(user: User) {
  const wallet = await findWallet(user.id);
  const [balances, setup] = wallet ? await Promise.all([balancesOf(wallet.publicKey), walletSetup(wallet.publicKey)]) : [null, null];
  return {
    user: publicUser(user),
    // The Pollar wallet links at sign-in (or a moment later, see useWalletSetup); not a profile step.
    needsProfile: !user.handle || !user.gender,
    hasPin: Boolean(user.pinHash),
    account: {
      status: user.status,
      /** While deleting: when the account closes for good unless restored. */
      deleteAfter: user.deleteAfter?.toISOString() ?? null,
      daysLeft: user.deleteAfter ? Math.max(1, Math.ceil((user.deleteAfter.getTime() - Date.now()) / 86_400_000)) : null,
      restoreDays: RESTORE_DAYS,
    },
    wallet: wallet
      ? {
          publicKey: wallet.publicKey,
          explorer: accountUrl(wallet.publicKey),
          balances: { NGN: balances?.NGN ?? 0, USDC: balances?.USDC ?? 0 },
          /**
           * Pollar opens the account; the app then adds these trustlines through Pollar and calls
           * POST /api/wallet/setup for the welcome money. Empty and `onChain` = ready.
           */
          setup: { onChain: setup?.onChain ?? false, missing: setup?.missing ?? [], welcomed: Boolean(user.welcomedAt) },
        }
      : null,
  };
}

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, handle: u.handle, gender: u.gender, language: u.language };
}

export async function updateProfile(
  user: User,
  input: { name?: string; handle?: string; gender?: Gender; language?: string },
) {
  const d = await db();
  if (input.handle && (await isHandleTaken(input.handle, user.id))) {
    throw new HttpError(409, `@${input.handle} is taken. Try another username.`);
  }
  const [updated] = await d.update(schema.users).set(input).where(eq(schema.users.id, user.id)).returning();
  return updated;
}

/**
 * The app calls this once the Pollar wallet is on-chain with its NGN and USDC trustlines: pays the
 * welcome money (once). Safe to call repeatedly.
 */
export async function finishWalletSetup(user: User) {
  const result = await payWelcomeGrant(user.id);
  if (result) {
    await record(
      { userId: user.id, kind: 'deposit', title: 'Welcome to Tappi', tag: 'Deposit', asset: 'NGN', amount: WELCOME_GRANT.NGN, txHash: result.hash },
      { userId: user.id, kind: 'deposit', title: 'Welcome to Tappi', tag: 'Deposit', asset: 'USDC', amount: WELCOME_GRANT.USDC, txHash: result.hash },
    );
  }
  const fresh = await (await db()).query.users.findFirst({ where: eq(schema.users.id, user.id) });
  return me(fresh ?? user);
}

export async function lookupHandle(raw: string) {
  const handle = normalizeHandle(raw);
  const user = HANDLE_PATTERN.test(handle)
    ? await (await db()).query.users.findFirst({ where: eq(schema.users.handle, handle) })
    : undefined;
  if (!user || user.status === 'deleting' || user.status === 'closed' || !(await findWallet(user.id))) {
    throw new HttpError(404, `No Tappi user called @${handle}.`);
  }
  assertCanReceive(user, `@${handle}`);
  return { name: displayName(user), handle: user.handle, gender: user.gender };
}

// ---------------- Test deposits ("Add Money" on testnet) ----------------

export const FAUCET = { NGN: 50_000, USDC: 50 } as const;
const FAUCET_COOLDOWN_MS = 60_000;

export async function fund(user: User, asset: Asset) {
  assertOwnReceiving(user);
  const d = await db();
  const last = await d.query.entries.findFirst({
    where: and(
      eq(schema.entries.userId, user.id),
      eq(schema.entries.kind, 'deposit'),
      eq(schema.entries.title, 'Test deposit'),
      eq(schema.entries.asset, asset),
      gt(schema.entries.createdAt, new Date(Date.now() - FAUCET_COOLDOWN_MS)),
    ),
    orderBy: desc(schema.entries.createdAt),
  });
  if (last) throw new HttpError(429, 'You just added money. Try again in a minute.');

  const wallet = await getWallet(user.id);
  const treasury = treasuryKeypair();
  const amount = FAUCET[asset];
  const result = await serialize(treasury.publicKey(), async () =>
    submitSponsored(
      await build(treasury.publicKey(), [
        Operation.payment({ destination: wallet.publicKey, asset: assetFor(asset), amount: amount7(amount) }),
      ], Memo.text('Tappi TEST DEPOSIT')),
      [treasury],
    ),
  );
  await record({ userId: user.id, kind: 'deposit', title: 'Test deposit', tag: 'Deposit', asset, amount, txHash: result.hash });
  return { amount, asset, tx: txUrl(result.hash) };
}

// ---------------- Send to a Tappi user ----------------

/** Builds the transfer for the phone to sign (see stellar/user-tx.ts); `sendTx.done` records it. */
export async function prepareSend(user: User, to: string, asset: Asset, amount: number) {
  const d = await db();
  const handle = to.replace(/^@/, '').toLowerCase();
  const recipient = await d.query.users.findFirst({ where: eq(schema.users.handle, handle) });
  if (!recipient) throw new HttpError(404, `No Tappi user called @${handle}.`);
  if (recipient.id === user.id) throw new HttpError(400, "You can't send money to yourself.");
  assertCanReceive(recipient, `@${handle}`);
  const toWallet = await getWallet(recipient.id);
  return prepareUserTx(
    user,
    'send',
    [Operation.payment({ destination: toWallet.publicKey, asset: assetFor(asset), amount: amount7(amount) })],
    Memo.text(`Tappi SEND @${handle}`.slice(0, 28)),
    { recipientId: recipient.id, asset, amount },
  );
}

export const sendTx: Handler = {
  done: async (row, user, hash) => {
    const { recipientId, asset, amount } = row.payload as { recipientId: string; asset: Asset; amount: number };
    const recipient = await (await db()).query.users.findFirst({ where: eq(schema.users.id, recipientId) });
    const name = recipient ? displayName(recipient) : 'a Tappi user';
    await record(
      { userId: user.id, kind: 'payment_out', title: name, tag: 'Transfer', asset, amount: -amount, channel: 'send', txHash: hash },
      ...(recipient
        ? [{ userId: recipient.id, kind: 'payment_in' as const, title: displayName(user), tag: 'Transfer', asset, amount, channel: 'send' as const, txHash: hash }]
        : []),
    );
    return { tx: txUrl(hash), to: name };
  },
};

// ---------------- Swap NGN ⇄ USDC (path payment on the testnet exchange) ----------------

const other = (asset: Asset): Asset => (asset === 'NGN' ? 'USDC' : 'NGN');
const SLIPPAGE = 0.01;

export async function quote(from: Asset, amount: number) {
  const { records } = await horizon().strictSendPaths(assetFor(from), amount7(amount), [assetFor(other(from))]).call();
  const best = records.sort((a, b) => Number(b.destination_amount) - Number(a.destination_amount))[0];
  if (!best) throw new HttpError(503, 'Swaps are unavailable right now (no liquidity).');
  const receive = Number(best.destination_amount);
  const ngnPerUsdc = from === 'NGN' ? amount / receive : receive / amount;
  return { from, to: other(from), amount, receive, rate: ngnPerUsdc };
}

/** How much of `from` it costs to deliver exactly `amount` of the other asset. */
export async function quoteReceive(from: Asset, amount: number) {
  const to = other(from);
  const { records } = await horizon().strictReceivePaths([assetFor(from)], assetFor(to), amount7(amount)).call();
  const best = records.sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
  if (!best) throw new HttpError(503, 'Paying from USDC is unavailable right now (no liquidity).');
  return { from, to, amount, cost: Number(best.source_amount) };
}

let cachedRate: { value: number; at: number } | null = null;

/** Live NGN per USDC: what 1 USDC sells for right now (cached for 30 s). */
export async function liveRate() {
  if (cachedRate && Date.now() - cachedRate.at < 30_000) return cachedRate.value;
  const value = (await quote('USDC', 1)).rate;
  cachedRate = { value, at: Date.now() };
  return value;
}

/** Builds the swap (a path payment back to the user's own wallet) for the phone to sign. */
export async function prepareSwap(user: User, from: Asset, amount: number) {
  const q = await quote(from, amount);
  const wallet = await getWallet(user.id);
  const before = (await balancesOf(wallet.publicKey))?.[q.to] ?? 0;
  return prepareUserTx(
    user,
    'swap',
    [
      Operation.pathPaymentStrictSend({
        sendAsset: assetFor(from),
        sendAmount: amount7(amount),
        destination: wallet.publicKey,
        destAsset: assetFor(q.to),
        destMin: amount7(q.receive * (1 - SLIPPAGE)),
        path: [],
      }),
    ],
    Memo.text(`Tappi SWAP ${from}-${q.to}`),
    { from, to: q.to, amount, receive: q.receive, before },
  );
}

export const swapTx: Handler = {
  done: async (row, user, hash) => {
    const p = row.payload as { from: Asset; to: Asset; amount: number; receive: number; before: number };
    const wallet = await getWallet(user.id);
    const after = (await balancesOf(wallet.publicKey))?.[p.to] ?? p.before + p.receive;
    const received = Number((Math.max(0, after - p.before) || p.receive).toFixed(7));
    await record({
      userId: user.id,
      kind: 'swap',
      title: `${p.from} → ${p.to}`,
      tag: 'Swap',
      asset: p.from,
      amount: -p.amount,
      assetIn: p.to,
      amountIn: received,
      txHash: hash,
    });
    return { received, asset: p.to, tx: txUrl(hash) };
  },
};

