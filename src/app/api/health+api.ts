import { sql } from 'drizzle-orm';

import { db, isLocalDb } from '@/server/db';
import { balancesOf } from '@/server/stellar/accounts';
import { accountUrl, treasuryKeypair } from '@/server/stellar/config';

/** GET /api/health — proves the phone can reach the backend, the database and Stellar testnet. */
export async function GET() {
  const checks: Record<string, unknown> = { network: 'testnet' };

  try {
    await (await db()).execute(sql`select 1`);
    checks.database = isLocalDb() ? 'pglite (local)' : 'postgres';
  } catch (error) {
    checks.database = { error: String(error) };
  }

  try {
    const treasury = treasuryKeypair().publicKey();
    checks.treasury = { publicKey: treasury, balances: await balancesOf(treasury), explorer: accountUrl(treasury) };
  } catch (error) {
    checks.treasury = { error: error instanceof Error ? error.message : String(error) };
  }

  const ok = typeof checks.database === 'string' && !('error' in (checks.treasury as object));
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}
