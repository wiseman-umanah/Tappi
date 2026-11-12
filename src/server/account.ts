import { and, eq, isNotNull, lt, or } from 'drizzle-orm';

import type { User } from './auth';
import { hmac } from './crypto';
import { db, schema } from './db';
import { HttpError } from './errors';
import { RESTORE_DAYS, RETENTION_YEARS } from './status';

/**
 * Account lifecycle
 *
 *   disable  → incoming money stops (sends, charges, deposits). The user can still sign in, spend
 *              and move their balance out, and turn it back on any time.
 *   delete   → status `deleting`: signed out everywhere, open charges cancelled, @handle and
 *              balance kept. Signing in within RESTORE_DAYS offers "Restore my account".
 *   close    → after RESTORE_DAYS: name, email, handle, avatar and PIN are erased and the Pollar
 *              link dropped. The wallet is Pollar's and the user's, so its balance stays theirs
 *              (Tappi can't move it, and shouldn't). The ledger stays, tied to an anonymous user
 *              row and an email HMAC, until `retainUntil`. The same email can then sign up again
 *              as a brand-new account with no history.
 *   erase    → after RETENTION_YEARS the user row and its ledger are deleted for good.
 */
const DAY = 86_400_000;
/** ACCOUNT_RESTORE_DAYS shortens the window for testing (fractions allowed). */
const restoreWindowMs = () => Number(process.env.ACCOUNT_RESTORE_DAYS || RESTORE_DAYS) * DAY;

export async function setReceiving(user: User, enabled: boolean) {
  if (user.status !== 'active' && user.status !== 'disabled') throw new HttpError(409, 'This account is being deleted.');
  const [updated] = await (await db())
    .update(schema.users)
    .set({ status: enabled ? 'active' : 'disabled' })
    .where(eq(schema.users.id, user.id))
    .returning();
  return updated;
}

export async function deleteAccount(user: User) {
  const d = await db();
  const deleteAfter = new Date(Date.now() + restoreWindowMs());
  await d.update(schema.users).set({ status: 'deleting', deleteAfter }).where(eq(schema.users.id, user.id));
  await d
    .update(schema.paymentRequests)
    .set({ status: 'cancelled' })
    .where(and(eq(schema.paymentRequests.merchantId, user.id), eq(schema.paymentRequests.status, 'pending')));
  await d.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
  await d.delete(schema.nearbyBeacons).where(eq(schema.nearbyBeacons.userId, user.id));
  return { deleteAfter: deleteAfter.toISOString() };
}

export async function restoreAccount(user: User) {
  if (user.status !== 'deleting') throw new HttpError(409, 'This account is not being deleted.');
  if (!user.deleteAfter || user.deleteAfter < new Date()) {
    throw new HttpError(410, 'The restore window has ended. Sign in again to start a new account.');
  }
  const [updated] = await (await db())
    .update(schema.users)
    .set({ status: 'active', deleteAfter: null })
    .where(eq(schema.users.id, user.id))
    .returning();
  return updated;
}

/**
 * End of the restore window: erase personal data, keep the ledger. Returns false when another
 * request is already closing this account.
 */
export async function closeAccount(user: User) {
  const d = await db();
  // Claim it first (clearing deleteAfter) so a sign-in and the purge can't both close it.
  const [claimed] = await d
    .update(schema.users)
    .set({ deleteAfter: null })
    .where(and(eq(schema.users.id, user.id), eq(schema.users.status, 'deleting'), isNotNull(schema.users.deleteAfter)))
    .returning();
  if (!claimed) return false;

  const closedAt = new Date();
  const retainUntil = new Date(closedAt);
  retainUntil.setFullYear(retainUntil.getFullYear() + RETENTION_YEARS);
  await d.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
  // Tappi AI chats are personal data, not ledger.
  await d.delete(schema.aiConversations).where(eq(schema.aiConversations.userId, user.id));
  await d.delete(schema.cards).where(eq(schema.cards.userId, user.id));
  await d.delete(schema.nearbyBeacons).where(eq(schema.nearbyBeacons.userId, user.id));
  await d.delete(schema.personTaps).where(or(eq(schema.personTaps.payerId, user.id), eq(schema.personTaps.payeeId, user.id)));
  await d.delete(schema.userTxs).where(eq(schema.userTxs.userId, user.id));
  await d
    .update(schema.users)
    .set({
      status: 'closed',
      emailHash: user.email ? hmac(`email:${user.email}`) : user.emailHash,
      email: null,
      name: null,
      handle: null,
      gender: null,
      pinHash: null,
      pollarUserId: null,
      deleteAfter: null,
      closedAt,
      retainUntil,
    })
    .where(eq(schema.users.id, user.id));
  return true;
}

/** For sign-in: closes an account past its window, or waits while another request does. */
export async function closeExpiredAccount(user: User) {
  if (await closeAccount(user)) return;
  for (let i = 0; i < 30; i++) {
    const row = await (await db()).query.users.findFirst({ where: eq(schema.users.id, user.id) });
    if (!row || row.status === 'closed') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new HttpError(503, 'Your old account is still being closed. Try again in a minute.');
}

let lastPurge = 0;

/**
 * Closes accounts whose restore window ended and erases closed accounts past retention. Runs at
 * most every 10 minutes from sign-in requests; `pnpm accounts:purge` runs it on demand.
 */
export async function purgeAccounts({ force = false } = {}) {
  if (!force && Date.now() - lastPurge < 10 * 60_000) return null;
  lastPurge = Date.now();
  const d = await db();
  const now = new Date();
  const due = await d.query.users.findMany({
    where: and(eq(schema.users.status, 'deleting'), lt(schema.users.deleteAfter, now)),
  });
  let closed = 0;
  for (const user of due) {
    try {
      if (await closeAccount(user)) closed++;
    } catch (error) {
      console.error(`[tappi] closing account ${user.id} failed`, error);
    }
  }
  const erased = await d
    .delete(schema.users)
    .where(and(eq(schema.users.status, 'closed'), lt(schema.users.retainUntil, now)))
    .returning({ id: schema.users.id });
  return { closed, erased: erased.length };
}
