import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { and, eq, gt } from 'drizzle-orm';

import { closeExpiredAccount, purgeAccounts } from './account';
import { hmac, randomCode, randomToken, safeEqual } from './crypto';
import { db, schema } from './db';
import { HttpError } from './errors';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 5 * 60_000;

export type User = typeof schema.users.$inferSelect;

/**
 * Testnet only: the code is returned to the app, which fills it in for the user. Set
 * TAPPI_AUTO_CODE=false to stop returning it (codes are always printed to the server console).
 */
const autoCode = () => process.env.TAPPI_AUTO_CODE !== 'false';

export async function requestCode(email: string) {
  const code = randomCode();
  await (await db())
    .insert(schema.loginCodes)
    .values({ email, codeHash: hmac(`${email}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL_MS) })
    .onConflictDoUpdate({
      target: schema.loginCodes.email,
      set: { codeHash: hmac(`${email}:${code}`), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
  console.info(`[tappi] login code for ${email}: ${code}`);
  void purgeAccounts().catch((error) => console.error('[tappi] account purge failed', error));
  return { sent: true, devCode: autoCode() ? code : undefined };
}

/** Checks the code, creates the user on first sign-in, and returns a new session token. */
export async function verifyCode(email: string, code: string) {
  const d = await db();
  const row = await d.query.loginCodes.findFirst({ where: eq(schema.loginCodes.email, email) });
  if (!row || row.expiresAt < new Date()) throw new HttpError(400, 'That code has expired. Request a new one.');
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Request a new code.');
  if (!safeEqual(row.codeHash, hmac(`${email}:${code}`))) {
    await d.update(schema.loginCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.loginCodes.email, email));
    throw new HttpError(400, "That code isn't right.");
  }
  await d.delete(schema.loginCodes).where(eq(schema.loginCodes.email, email));

  // Back after the restore window but before the purge ran: close the old account first, so this
  // sign-in starts a brand-new one. Within the window the old account signs in to be restored.
  const existing = await d.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing?.status === 'deleting' && (!existing.deleteAfter || existing.deleteAfter < new Date())) {
    await closeExpiredAccount(existing);
  }

  const [user] = await d
    .insert(schema.users)
    .values({ email })
    .onConflictDoUpdate({ target: schema.users.email, set: { email } })
    .returning();
  const token = randomToken();
  await d.insert(schema.sessions).values({
    tokenHash: hmac(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { token, user };
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
