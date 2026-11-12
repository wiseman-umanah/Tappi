import { Keypair, type Memo, Transaction, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import { and, eq, gt, lt } from 'drizzle-orm';

import type { User } from '../auth';
import { db, schema } from '../db';
import type { UserTxKind } from '../db/schema';
import { HttpError } from '../errors';
import { getWallet } from './accounts';
import { NETWORK_PASSPHRASE } from './config';
import { build, submitFeeBumped } from './submit';

/**
 * Money that leaves a user's wallet moves in two steps, because Pollar holds the wallet and only the
 * user's phone can ask it to sign:
 *
 *   1. prepare (server): checks the PIN and the rules, builds the transaction with the user's
 *      wallet as source and keeps it here → { id, xdr } to the phone.
 *   2. the phone signs `xdr` through Pollar (`signTx`, no Pollar sponsorship) and posts it back to
 *      POST /api/tx/:id; `submitUserTx` accepts it only if it is that exact transaction, signed by
 *      the wallet, then the treasury fee-bumps it (users hold no XLM) and it goes on-chain.
 *
 * What happens around the submit (claiming a charge, recording entries) is per kind: see the
 * handlers in src/server/transactions.ts.
 */
export type Prepared = { id: string; xdr: string; expiresAt: string };

/** The phone has this long to sign; the transaction's own timebound is the same (submit.ts). */
const SIGN_WINDOW_MS = 120_000;

export async function prepareUserTx(
  user: User,
  kind: UserTxKind,
  operations: xdr.Operation[],
  memo: Memo,
  payload: Record<string, unknown>,
  options: { requestId?: string } = {},
): Promise<Prepared> {
  const wallet = await getWallet(user.id);
  if (wallet.encryptedSecret) throw new HttpError(409, 'This is an old Tappi wallet. Sign in again to use your Pollar wallet.');
  const tx = await build(wallet.publicKey, operations, memo);
  const d = await db();
  // One open transaction per user and kind is enough; older ones can't land (same sequence).
  await d.delete(schema.userTxs).where(and(eq(schema.userTxs.userId, user.id), eq(schema.userTxs.kind, kind)));
  await d.delete(schema.userTxs).where(lt(schema.userTxs.expiresAt, new Date()));
  const expiresAt = new Date(Date.now() + SIGN_WINDOW_MS);
  const [row] = await d
    .insert(schema.userTxs)
    .values({
      userId: user.id,
      kind,
      xdr: tx.toXDR(),
      hash: Buffer.from(tx.hash()).toString('hex'),
      payload,
      requestId: options.requestId ?? null,
      expiresAt,
    })
    .returning();
  return { id: row.id, xdr: row.xdr, expiresAt: expiresAt.toISOString() };
}

type Row = typeof schema.userTxs.$inferSelect;
export type Handler = {
  /** Before it goes on-chain (e.g. claim the charge so nobody else pays it). Throw to stop. */
  claim?: (row: Row, user: User) => Promise<void>;
  /** It didn't land: undo `claim`. */
  release?: (row: Row) => Promise<void>;
  /** It landed: record it and answer the phone. */
  done: (row: Row, user: User, hash: string) => Promise<unknown>;
};

/** Checks that `signedXdr` is the prepared transaction, signed by the user's wallet. */
export function verifySigned(row: Pick<Row, 'hash'>, signedXdr: string, publicKey: string) {
  let signed: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    if (!(parsed instanceof Transaction)) throw new Error('fee bump');
    signed = parsed;
  } catch {
    throw new HttpError(400, "That isn't a signed Tappi transaction.");
  }
  const hash = Buffer.from(signed.hash());
  if (hash.toString('hex') !== row.hash) throw new HttpError(400, 'The signed transaction was changed. Nothing was sent.');
  const key = Keypair.fromPublicKey(publicKey);
  const hint = Buffer.from(key.signatureHint());
  const ok = signed.signatures.some((s) => hint.equals(Buffer.from(s.hint.value)) && key.verify(hash, Buffer.from(s.signature.value)));
  if (!ok) throw new HttpError(400, "The wallet didn't sign this transaction.");
  return signed;
}

export async function submitUserTx(user: User, id: string, signedXdr: string, handlers: Record<UserTxKind, Handler>) {
  const d = await db();
  // Use it up first: a signed transaction is submitted once, even if the phone retries.
  const [row] = await d
    .delete(schema.userTxs)
    .where(and(eq(schema.userTxs.id, id), eq(schema.userTxs.userId, user.id), gt(schema.userTxs.expiresAt, new Date())))
    .returning();
  if (!row) throw new HttpError(410, 'That took too long, so nothing was sent. Try again.');
  const handler = handlers[row.kind];

  const wallet = await getWallet(user.id);
  const signed = verifySigned(row, signedXdr, wallet.publicKey);
  await handler.claim?.(row, user);
  let hash: string;
  try {
    hash = (await submitFeeBumped(signed)).hash;
  } catch (error) {
    await handler.release?.(row);
    throw error;
  }
  return handler.done(row, user, hash);
}

/** The Tappi card charge waiting for this card holder's phone to sign, if any. */
export async function pendingCardTx(user: User) {
  const row = await (await db()).query.userTxs.findFirst({
    where: and(eq(schema.userTxs.userId, user.id), eq(schema.userTxs.kind, 'pay'), gt(schema.userTxs.expiresAt, new Date())),
  });
  return row && row.payload.channel === 'tappi_card' ? row : null;
}
