import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { and, eq, gt } from 'drizzle-orm';

import { closeExpiredAccount, purgeAccounts } from './account';
import { hmac, randomToken } from './crypto';
import { db, schema } from './db';
import { HttpError } from './errors';
import { verifyPollarToken } from './pollar';
import { linkWallet } from './stellar/accounts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 5 * 60_000;

export type User = typeof schema.users.$inferSelect;

/**
 * Sign-in is Pollar's (email code, sent by Pollar). The app passes the Pollar access token once;
 * this checks it with Pollar, finds or creates the Tappi account, links the Pollar wallet and
 * returns a Tappi session token. Call it again later to link a wallet that wasn't ready yet.
 */
export async function signInWithPollar(pollarToken: string) {
  const pollar = await verifyPollarToken(pollarToken);
  if (pollar.network && pollar.network !== 'testnet') {
    throw new HttpError(400, 'Tappi runs on Stellar testnet. Use a Pollar test-mode key.');
  }
  const d = await db();
  void purgeAccounts().catch((error) => console.error('[tappi] account purge failed', error));

  let existing =
    (await d.query.users.findFirst({ where: eq(schema.users.pollarUserId, pollar.id) })) ??
    (pollar.email ? await d.query.users.findFirst({ where: eq(schema.users.email, pollar.email) }) : undefined);
  // Back after the restore window but before the purge ran: close the old account first, so this
  // sign-in starts a brand-new one. Within the window the old account signs in to be restored.
  if (existing?.status === 'deleting' && (!existing.deleteAfter || existing.deleteAfter < new Date())) {
    await closeExpiredAccount(existing);
    existing = undefined;
  }
  if (existing?.status === 'closed') existing = undefined;

  const [user] = existing
    ? await d
        .update(schema.users)
        .set({ pollarUserId: pollar.id, ...(pollar.email ? { email: pollar.email } : {}) })
        .where(eq(schema.users.id, existing.id))
        .returning()
    : await d
        .insert(schema.users)
        .values({ pollarUserId: pollar.id, email: pollar.email })
        .onConflictDoUpdate({ target: schema.users.pollarUserId, set: { email: pollar.email } })
        .returning();
  if (pollar.address) await linkWallet(user.id, pollar.address);

  const token = randomToken();
  await d.insert(schema.sessions).values({
    tokenHash: hmac(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { token, user };
}

/** Links the Pollar wallet to a signed-in account once Pollar has made it (no new session). */
export async function linkPollarWallet(user: User, pollarToken: string) {
  const pollar = await verifyPollarToken(pollarToken);
  if (pollar.id !== user.pollarUserId) throw new HttpError(403, 'That Pollar sign-in is for another account.');
  if (pollar.address) await linkWallet(user.id, pollar.address);
  return user;
}

export async function authenticate(request: Request): Promise<User | null> {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const d = await db();
  const session = await d.query.sessions.findFirst({
    where: and(eq(schema.sessions.tokenHash, hmac(token)), gt(schema.sessions.expiresAt, new Date())),
  });
  if (!session) return null;
  return (await d.query.users.findFirst({ where: eq(schema.users.id, session.userId) })) ?? null;
}

export async function signOut(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (token) await (await db()).delete(schema.sessions).where(eq(schema.sessions.tokenHash, hmac(token)));
}

// ---- Transaction PIN (scrypt, per-user salt, locks after repeated failures) ----

export async function setPin(userId: string, pin: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  await (await db())
    .update(schema.users)
    .set({ pinHash: `${salt.toString('hex')}:${hash.toString('hex')}`, pinFailures: 0, pinLockedUntil: null })
    .where(eq(schema.users.id, userId));
}

/** Throws unless `pin` is the user's PIN. Every money-moving route calls this first. */
export async function verifyPin(user: User, pin: string) {
  if (!user.pinHash) throw new HttpError(400, 'Set a transaction PIN first.');
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    const minutes = Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong PINs. Try again in ${minutes} min.`);
  }
  const [saltHex, hashHex] = user.pinHash.split(':');
  const actual = await scrypt(pin, Buffer.from(saltHex, 'hex'), 32);
  const d = await db();
  if (!timingSafeEqual(actual, Buffer.from(hashHex, 'hex'))) {
    const failures = user.pinFailures + 1;
    const locked = failures >= PIN_MAX_FAILURES;
    await d
      .update(schema.users)
      .set({
        pinFailures: locked ? 0 : failures,
        pinLockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MS) : null,
      })
      .where(eq(schema.users.id, user.id));
    throw new HttpError(
      400,
      locked ? 'Too many wrong PINs. Try again in 5 min.' : `Wrong PIN. ${PIN_MAX_FAILURES - failures} tries left.`,
    );
  }
  if (user.pinFailures) await d.update(schema.users).set({ pinFailures: 0 }).where(eq(schema.users.id, user.id));
}
