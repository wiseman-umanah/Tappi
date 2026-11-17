import { and, desc, eq, gt } from 'drizzle-orm';

import type { User } from './auth';
import { hmac, safeEqual } from './crypto';
import { db, schema } from './db';
import { HttpError } from './errors';
import { assertOwnReceiving } from './status';
import { displayName } from './wallet';

/**
 * Phone-to-phone taps. The phone being paid is always the reader — a merchant's terminal (so it
 * can read bank cards too) or a person on Receive; the payer's phone (on Pay) presents itself as an
 * NFC tag carrying `tappi://tap/<token>`. The token names the payer and expires quickly. Reading
 * it only tells the payer's phone who they touched: it then opens the charge, or Send to that
 * person, and they still approve with their PIN.
 */
const TOKEN_TTL_MS = 2 * 60_000;
/** How long a tapped charge keeps popping up on the customer's phone. */
const TAP_WINDOW_MS = 2 * 60_000;

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export function issueTapToken(user: User) {
  if (user.status === 'deleting' || user.status === 'closed') throw new HttpError(403, 'This account is being deleted.');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${user.id}.${Math.floor(expiresAt / 1000)}`;
  const token = `${b64(payload)}.${hmac(`tap:${payload}`).slice(0, 24)}`;
  return { token, link: `tappi://tap/${token}`, expiresAt: new Date(expiresAt).toISOString() };
}

function readTapToken(token: string) {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) throw new HttpError(400, "That isn't a Tappi phone.");
  const payload = Buffer.from(encoded, 'base64url').toString();
  if (!safeEqual(signature, hmac(`tap:${payload}`).slice(0, 24))) throw new HttpError(400, "That isn't a Tappi phone.");
  const [userId, exp] = payload.split('.');
  if (Number(exp) * 1000 < Date.now()) throw new HttpError(410, 'That phone needs to reopen Pay in Tappi, then tap again.');
  return userId;
}

/** Merchant's phone read a customer's phone: attach them to the open charge. */
export async function claimTap(merchant: User, requestId: string, token: string) {
  const d = await db();
  const customerId = readTapToken(token);
  if (customerId === merchant.id) throw new HttpError(400, "That's your own phone. Tap the customer's phone instead.");
  const customer = await d.query.users.findFirst({ where: eq(schema.users.id, customerId) });
  if (!customer || customer.status === 'deleting' || customer.status === 'closed') {
    throw new HttpError(404, 'That Tappi account is no longer active.');
  }
  const [row] = await d
    .update(schema.paymentRequests)
    .set({ tappedBy: customer.id, tappedAt: new Date() })
    .where(
      and(
        eq(schema.paymentRequests.id, requestId),
        eq(schema.paymentRequests.merchantId, merchant.id),
        eq(schema.paymentRequests.status, 'pending'),
        gt(schema.paymentRequests.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) throw new HttpError(409, 'This charge is no longer open.');
  return { customer: displayName(customer) };
}

/** A person on Receive read the payer's phone: the payer's Pay screen opens Send to them. */
export async function claimPersonTap(payee: User, token: string) {
  const d = await db();
  const payerId = readTapToken(token);
  if (payerId === payee.id) throw new HttpError(400, "That's your own phone.");
  assertOwnReceiving(payee);
  if (!payee.handle) throw new HttpError(409, 'Finish your profile to receive money.');
  const payer = await d.query.users.findFirst({ where: eq(schema.users.id, payerId) });
  if (!payer || payer.status === 'deleting' || payer.status === 'closed') {
    throw new HttpError(404, 'That Tappi account is no longer active.');
  }
  await d.insert(schema.personTaps).values({ payerId: payer.id, payeeId: payee.id });
  return { payer: displayName(payer) };
}

/**
 * The payer's phone polls this while presenting itself: what a payee's phone just read it into —
 * a merchant's charge, or a person to send to. The newer one wins.
 */
export async function pendingTap(user: User, since: Date) {
  const d = await db();
  const now = new Date();
  const after = new Date(Math.max(since.getTime() - 5_000, now.getTime() - TAP_WINDOW_MS)); // 5 s for clock drift
  const [charge, person] = await Promise.all([
    d.query.paymentRequests.findFirst({
      where: and(
        eq(schema.paymentRequests.tappedBy, user.id),
        eq(schema.paymentRequests.status, 'pending'),
        gt(schema.paymentRequests.expiresAt, now),
        gt(schema.paymentRequests.tappedAt, after),
      ),
      orderBy: desc(schema.paymentRequests.tappedAt),
    }),
    d.query.personTaps.findFirst({
      where: and(eq(schema.personTaps.payerId, user.id), gt(schema.personTaps.createdAt, after)),
      orderBy: desc(schema.personTaps.createdAt),
    }),
  ]);
  const payee = person ? await d.query.users.findFirst({ where: eq(schema.users.id, person.payeeId) }) : undefined;
  const personNewer = person && payee?.handle && (!charge?.tappedAt || person.createdAt > charge.tappedAt);
  return {
    charge: charge && !personNewer ? { code: charge.code } : null,
    person: personNewer && payee?.handle ? { handle: payee.handle, name: displayName(payee), gender: payee.gender } : null,
  };
}
