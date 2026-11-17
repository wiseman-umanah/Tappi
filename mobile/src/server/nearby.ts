import { randomBytes } from 'node:crypto';

import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';
import { HttpError } from './errors';
import { findWallet } from './stellar/accounts';
import { assertOwnReceiving } from './status';
import { displayName } from './wallet';

/**
 * "Who's around": phones in tap mode (Receive, or a merchant with a charge open) announce a random
 * Bluetooth beacon id (modules/tappi-nearby). Payers' phones hear the ids and ask here who they
 * are. Ids live a few minutes and are replaced while the screen stays open, so an id overheard
 * later says nothing. Only people who opened Receive (or a charge) can be found.
 */
const BEACON_TTL_MS = 3 * 60_000;
const MAX_IDS = 30;
export const BEACON_ID = /^[0-9a-f]{16}$/;

/** Start (or renew) this phone's beacon. With `requestId`, the merchant's open charge is announced. */
export async function issueBeacon(user: User, requestId?: string | null) {
  assertOwnReceiving(user);
  if (!user.handle || !(await findWallet(user.id))) throw new HttpError(409, 'Finish your profile to receive money.');
  const d = await db();
  if (requestId) {
    const charge = await d.query.paymentRequests.findFirst({
      where: and(
        eq(schema.paymentRequests.id, requestId),
        eq(schema.paymentRequests.merchantId, user.id),
        eq(schema.paymentRequests.status, 'pending'),
      ),
    });
    if (!charge) throw new HttpError(409, 'This charge is no longer open.');
  }
  const now = new Date();
  // One beacon per user; old ones (and anyone's expired ones) go.
  await d.delete(schema.nearbyBeacons).where(eq(schema.nearbyBeacons.userId, user.id));
  await d.delete(schema.nearbyBeacons).where(lt(schema.nearbyBeacons.expiresAt, now));
  const id = randomBytes(8).toString('hex');
  const expiresAt = new Date(now.getTime() + BEACON_TTL_MS);
  await d.insert(schema.nearbyBeacons).values({ id, userId: user.id, requestId: requestId ?? null, expiresAt });
  return { id, expiresAt: expiresAt.toISOString() };
}

export async function endBeacon(user: User) {
  await (await db()).delete(schema.nearbyBeacons).where(eq(schema.nearbyBeacons.userId, user.id));
  return { ok: true };
}

/** The people and merchants behind beacon ids this phone heard. Unknown or expired ids are left out. */
export async function resolveBeacons(viewer: User, ids: string[]) {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => BEACON_ID.test(id)).slice(0, MAX_IDS);
  if (!wanted.length) return { nearby: [] };
  const d = await db();
  const now = new Date();
  const beacons = await d.query.nearbyBeacons.findMany({
    where: and(
      inArray(schema.nearbyBeacons.id, wanted),
      gt(schema.nearbyBeacons.expiresAt, now),
      ne(schema.nearbyBeacons.userId, viewer.id),
    ),
  });
  if (!beacons.length) return { nearby: [] };

  const requestIds = beacons.flatMap((b) => (b.requestId ? [b.requestId] : []));
  const [people, charges] = await Promise.all([
    d.query.users.findMany({
      where: inArray(
        schema.users.id,
        beacons.map((b) => b.userId),
      ),
    }),
    requestIds.length === 0
      ? []
      : d.query.paymentRequests.findMany({
          where: and(
            inArray(schema.paymentRequests.id, requestIds),
            eq(schema.paymentRequests.status, 'pending'),
            gt(schema.paymentRequests.expiresAt, now),
          ),
        }),
  ]);
  const personById = new Map(people.map((p) => [p.id, p]));
  const chargeById = new Map(charges.map((c) => [c.id, c]));

  type Found = {
    kind: 'person' | 'merchant';
    beacon: string;
    name: string;
    handle: string;
    gender: User['gender'];
    /** Merchants: the open charge picking them pays. */
    charge: { code: string; amount: number; asset: 'NGN' | 'USDC'; tag: string } | null;
  };
  const nearby = beacons.flatMap((b): Found[] => {
    const person = personById.get(b.userId);
    // Only accounts that can take money in show up.
    if (!person?.handle || person.status !== 'active') return [];
    const who = {
      beacon: b.id,
      name: displayName(person),
      handle: person.handle,
      gender: person.gender,
    };
    if (!b.requestId) return [{ kind: 'person', ...who, charge: null }];
    const charge = chargeById.get(b.requestId);
    return charge
      ? [
          {
            kind: 'merchant',
            ...who,
            charge: {
              code: charge.code,
              amount: charge.amount,
              asset: charge.asset,
              tag: charge.tag,
            },
          },
        ]
      : [];
  });
  return { nearby };
}
