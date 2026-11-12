import { Memo, NotFoundError, Operation, type Horizon } from '@stellar/stellar-sdk';
import { and, eq, isNull } from 'drizzle-orm';

import { db, schema } from '../db';
import type { Asset } from '../db/schema';
import { HttpError } from '../errors';
import { amount7, assetFor, horizon, ngn, treasuryKeypair, usdc } from './config';
import { serialize } from './lock';
import { build, submitSponsored } from './submit';

/** Test money every new wallet starts with, so the app isn't empty on day one. */
export const WELCOME_GRANT = { NGN: 50_000, USDC: 25 };

/**
 * Records the user's Pollar wallet (Pollar creates it and holds its key; Tappi only knows the
 * address). Re-linking the same address is a no-op.
 */
export async function linkWallet(userId: string, publicKey: string) {
  const d = await db();
  const owner = await d.query.wallets.findFirst({ where: eq(schema.wallets.publicKey, publicKey) });
  if (owner && owner.userId !== userId) throw new HttpError(409, 'That wallet belongs to another Tappi account.');
  await d
    .insert(schema.wallets)
    .values({ userId, publicKey })
    .onConflictDoUpdate({ target: schema.wallets.userId, set: { publicKey, encryptedSecret: null } });
}

export async function findWallet(userId: string) {
  return (await db()).query.wallets.findFirst({ where: eq(schema.wallets.userId, userId) });
}

export async function getWallet(userId: string) {
  const wallet = await findWallet(userId);
  if (!wallet) throw new Error('No wallet for user');
  return wallet;
}

export async function loadAccountOrNull(publicKey: string) {
  try {
    return await horizon().loadAccount(publicKey);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** Where a Pollar wallet stands on-chain: Pollar opens the account, the app adds the trustlines. */
export async function walletSetup(publicKey: string) {
  const account = await loadAccountOrNull(publicKey);
  if (!account) return { onChain: false, missing: ['NGN', 'USDC'] as Asset[] };
  const has = (code: string, issuer: string) =>
    account.balances.some((b) => 'asset_code' in b && b.asset_code === code && b.asset_issuer === issuer);
  const missing: Asset[] = (['NGN', 'USDC'] as const).filter((a) => !has(a, assetFor(a).getIssuer() ?? ''));
  return { onChain: true, missing };
}

/**
 * The welcome money, once the wallet can hold it: treasury → user, paid once per account (the
 * claim on `welcomedAt` stops a double grant). Null if it isn't ready or was already paid.
 */
export async function payWelcomeGrant(userId: string) {
  const wallet = await getWallet(userId);
  const setup = await walletSetup(wallet.publicKey);
  if (!setup.onChain || setup.missing.length) return null;
  const d = await db();
  const [claimed] = await d
    .update(schema.users)
    .set({ welcomedAt: new Date() })
    .where(and(eq(schema.users.id, userId), isNull(schema.users.welcomedAt)))
    .returning();
  if (!claimed) return null;
  const treasury = treasuryKeypair();
  try {
    return await serialize(treasury.publicKey(), async () =>
      submitSponsored(
        await build(treasury.publicKey(), [
          Operation.payment({ destination: wallet.publicKey, asset: ngn(), amount: amount7(WELCOME_GRANT.NGN) }),
          Operation.payment({ destination: wallet.publicKey, asset: usdc(), amount: amount7(WELCOME_GRANT.USDC) }),
        ], Memo.text('Tappi WELCOME')),
        [treasury],
      ),
    );
  } catch (error) {
    await d.update(schema.users).set({ welcomedAt: null }).where(eq(schema.users.id, userId));
    throw error;
  }
}

export type Balances = { NGN: number; USDC: number; XLM: number };

export function readBalances(account: Horizon.AccountResponse): Balances {
  const out: Balances = { NGN: 0, USDC: 0, XLM: 0 };
  const ngnIssuer = ngn().getIssuer();
  const usdcIssuer = usdc().getIssuer();
  for (const line of account.balances) {
    if (line.asset_type === 'native') out.XLM = Number(line.balance);
    else if ('asset_code' in line && line.asset_code === 'NGN' && line.asset_issuer === ngnIssuer)
      out.NGN = Number(line.balance);
    else if ('asset_code' in line && line.asset_code === 'USDC' && line.asset_issuer === usdcIssuer)
      out.USDC = Number(line.balance);
  }
  return out;
}

export async function balancesOf(publicKey: string): Promise<Balances | null> {
  const account = await loadAccountOrNull(publicKey);
  return account ? readBalances(account) : null;
}
