import { Keypair, Memo, NotFoundError, Operation, type Horizon } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';

import { decryptSecret, encryptSecret } from '../crypto';
import { db, schema } from '../db';
import { amount7, horizon, ngn, treasuryKeypair, usdc } from './config';
import { serialize } from './lock';
import { build, submitSigned } from './submit';

/** Test money every new wallet starts with, so the app isn't empty on day one. */
export const WELCOME_GRANT = { NGN: 50_000, USDC: 25 };

/** Creates the user's custodial wallet: a fresh keypair whose secret is stored encrypted. */
export async function createWallet(userId: string) {
  const keypair = Keypair.random();
  await (await db())
    .insert(schema.wallets)
    .values({
      userId,
      publicKey: keypair.publicKey(),
      encryptedSecret: encryptSecret(keypair.secret(), keypair.publicKey()),
    })
    .onConflictDoNothing();
  return getWallet(userId);
}

export async function findWallet(userId: string) {
  return (await db()).query.wallets.findFirst({ where: eq(schema.wallets.userId, userId) });
}

export async function getWallet(userId: string) {
  const wallet = await findWallet(userId);
  if (!wallet) throw new Error('No wallet for user');
  return wallet;
}

export async function walletKeypair(userId: string) {
  const wallet = await getWallet(userId);
  if (!wallet.encryptedSecret) throw new Error('This wallet was closed');
  return Keypair.fromSecret(decryptSecret(wallet.encryptedSecret, wallet.publicKey));
}

export async function loadAccountOrNull(publicKey: string) {
  try {
    return await horizon().loadAccount(publicKey);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * Puts the user's wallet on-chain with NGN and USDC trustlines and pays the welcome grant, in one
 * transaction. The treasury sponsors every reserve (CAP-33), so the account holds 0 XLM and the
 * user never needs any. Idempotent: returns null when the account already exists.
 */
export async function activateWallet(userId: string) {
  const wallet = await getWallet(userId);
  if (await loadAccountOrNull(wallet.publicKey)) return null;

  const treasury = treasuryKeypair();
  const user = await walletKeypair(userId);
  return serialize(treasury.publicKey(), async () => {
    const tx = await build(treasury.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: wallet.publicKey }),
      Operation.createAccount({ destination: wallet.publicKey, startingBalance: '0' }),
      Operation.changeTrust({ asset: ngn(), source: wallet.publicKey }),
      Operation.changeTrust({ asset: usdc(), source: wallet.publicKey }),
      Operation.endSponsoringFutureReserves({ source: wallet.publicKey }),
      Operation.payment({ destination: wallet.publicKey, asset: ngn(), amount: amount7(WELCOME_GRANT.NGN) }),
      Operation.payment({ destination: wallet.publicKey, asset: usdc(), amount: amount7(WELCOME_GRANT.USDC) }),
    ], Memo.text('Tappi WELCOME'));
    return submitSigned(tx, [treasury, user]);
  });
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
