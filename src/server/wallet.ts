import { Memo, Operation } from '@stellar/stellar-sdk';
import { and, desc, eq, gt } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';
import type { Asset, Gender } from './db/schema';
import { HttpError } from './errors';
import { HANDLE_PATTERN, isHandleTaken, normalizeHandle } from './handles';
import {
  activateWallet,
  balancesOf,
  createWallet,
  findWallet,
  getWallet,
  WELCOME_GRANT,
  walletKeypair,
} from './stellar/accounts';
import { accountUrl, amount7, assetFor, horizon, treasuryKeypair, txUrl } from './stellar/config';
import { serialize } from './stellar/lock';
import { build, submitSponsored } from './stellar/submit';
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
  const balances = wallet ? await balancesOf(wallet.publicKey) : null;
  return {
    user: publicUser(user),
    needsProfile: !user.handle || !user.gender || !wallet,
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
        }
      : null,
  };
}

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, handle: u.handle, gender: u.gender };
}

export async function updateProfile(user: User, input: { name?: string; handle?: string; gender?: Gender }) {
  const d = await db();
  if (input.handle && (await isHandleTaken(input.handle, user.id))) {
    throw new HttpError(409, `@${input.handle} is taken. Try another username.`);
  }
  const [updated] = await d.update(schema.users).set(input).where(eq(schema.users.id, user.id)).returning();

  // First time the profile is complete: create the custodial wallet and put it on-chain.
  if (updated.handle && updated.gender && !(await findWallet(user.id))) {
    await createWallet(user.id);
    const result = await activateWallet(user.id);
    if (result) {
      await record(
        { userId: user.id, kind: 'deposit', title: 'Welcome to Tappi', tag: 'Deposit', asset: 'NGN', amount: WELCOME_GRANT.NGN, txHash: result.hash },
        { userId: user.id, kind: 'deposit', title: 'Welcome to Tappi', tag: 'Deposit', asset: 'USDC', amount: WELCOME_GRANT.USDC, txHash: result.hash },
      );
    }
  }
  return updated;
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

export async function send(user: User, to: string, asset: Asset, amount: number) {
  const d = await db();
  const handle = to.replace(/^@/, '').toLowerCase();
  const recipient = await d.query.users.findFirst({ where: eq(schema.users.handle, handle) });
  if (!recipient) throw new HttpError(404, `No Tappi user called @${handle}.`);
  if (recipient.id === user.id) throw new HttpError(400, "You can't send money to yourself.");
  assertCanReceive(recipient, `@${handle}`);
  const [from, toWallet] = await Promise.all([walletKeypair(user.id), getWallet(recipient.id)]);

  const result = await serialize(from.publicKey(), async () =>
    submitSponsored(
      await build(from.publicKey(), [
        Operation.payment({ destination: toWallet.publicKey, asset: assetFor(asset), amount: amount7(amount) }),
      ], Memo.text(`Tappi SEND @${handle}`.slice(0, 28))),
      [from],
    ),
  );
  await record(
    { userId: user.id, kind: 'payment_out', title: displayName(recipient), tag: 'Transfer', asset, amount: -amount, channel: 'send', txHash: result.hash },
    { userId: recipient.id, kind: 'payment_in', title: displayName(user), tag: 'Transfer', asset, amount, channel: 'send', txHash: result.hash },
  );
  return { tx: txUrl(result.hash), to: displayName(recipient) };
}

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

export async function swap(user: User, from: Asset, amount: number) {
  const q = await quote(from, amount);
  const keypair = await walletKeypair(user.id);
  const before = (await balancesOf(keypair.publicKey()))?.[q.to] ?? 0;
  const result = await serialize(keypair.publicKey(), async () =>
    submitSponsored(
      await build(keypair.publicKey(), [
        Operation.pathPaymentStrictSend({
          sendAsset: assetFor(from),
          sendAmount: amount7(amount),
          destination: keypair.publicKey(),
          destAsset: assetFor(q.to),
          destMin: amount7(q.receive * (1 - SLIPPAGE)),
          path: [],
        }),
      ], Memo.text(`Tappi SWAP ${from}-${q.to}`)),
      [keypair],
    ),
  );
  const after = (await balancesOf(keypair.publicKey()))?.[q.to] ?? before + q.receive;
  const received = Number((Math.max(0, after - before) || q.receive).toFixed(7));
  await record({
    userId: user.id,
    kind: 'swap',
    title: `${from} → ${q.to}`,
    tag: 'Swap',
    asset: from,
    amount: -amount,
    assetIn: q.to,
    amountIn: received,
    txHash: result.hash,
  });
  return { received, asset: q.to, tx: txUrl(result.hash) };
}

