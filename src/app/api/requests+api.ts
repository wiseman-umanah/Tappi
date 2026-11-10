import { z } from 'zod';

import { amountField, body, requireUser, route } from '@/server/http';
import { createRequest } from '@/server/merchant';

/** POST /api/requests { amount, tag } — the merchant Terminal's Charge button. */
export const POST = route(async (request) => {
  const merchant = await requireUser(request);
  const { amount, tag } = await body(request, z.object({ amount: amountField, tag: z.string().min(1).max(30) }));
  return createRequest(merchant, amount, tag);
});
