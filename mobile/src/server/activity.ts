import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';
import { txUrl } from './stellar/config';
import { liveRate } from './wallet';

/** Activity screen: recent entries, this month's spending by tag, and swap insight. */
export async function activity(user: User) {
  const d = await db();
  const rows = await d.query.entries.findMany({
    where: eq(schema.entries.userId, user.id),
    orderBy: desc(schema.entries.createdAt),
    limit: 100,
  });
  const rate = await liveRate().catch(() => Number(process.env.NGN_PER_USDC || 1569));

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  // Refunds count against the tag they were spent on.
  const spent = await d.query.entries.findMany({
    where: and(
      eq(schema.entries.userId, user.id),
      inArray(schema.entries.kind, ['payment_out', 'refund_in']),
      gte(schema.entries.createdAt, monthStart),
    ),
  });
  const byTag = new Map<string, number>();
  let total = 0;
  for (const e of spent) {
    const ngn = e.asset === 'NGN' ? -e.amount : -e.amount * rate;
    total += ngn;
    byTag.set(e.tag, (byTag.get(e.tag) ?? 0) + ngn);
  }
  const tags = [...byTag.entries()]
    .filter(([, amount]) => amount > 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, amount]) => ({ tag, amount, percent: total ? Math.round((amount / total) * 100) : 0 }));

  const swaps = rows.filter((e) => e.kind === 'swap');
  const toUsdc = swaps.filter((e) => e.asset === 'NGN');
  const ngnIn = toUsdc.reduce((s, e) => s - e.amount, 0);
  const usdcOut = toUsdc.reduce((s, e) => s + (e.amountIn ?? 0), 0);

  return {
    entries: rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      tag: e.tag,
      asset: e.asset,
      amount: e.amount,
      assetIn: e.assetIn,
      amountIn: e.amountIn,
      channel: e.channel,
      at: e.createdAt.toISOString(),
      tx: txUrl(e.txHash),
    })),
    spending: { total, payments: spent.filter((e) => e.kind === 'payment_out').length, tags },
    conversions: {
      swappedIn: usdcOut,
      avgRate: usdcOut ? ngnIn / usdcOut : null,
      liveRate: rate,
      history: swaps.slice(0, 20).map((e) => ({
        id: e.id,
        from: e.asset,
        sent: -e.amount,
        to: e.assetIn,
        received: e.amountIn ?? 0,
        rate: e.asset === 'NGN' ? -e.amount / (e.amountIn || 1) : (e.amountIn ?? 0) / -e.amount,
        at: e.createdAt.toISOString(),
      })),
    },
  };
}
