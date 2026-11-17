import { z } from 'zod';

import { amountField, assetField, body, requireUser, route } from '@/server/http';
import { createRequest } from '@/server/merchant';

/** POST /api/requests { amount, asset?, tag } — the merchant Terminal's Charge button (NGN or USDC). */
export const POST = route(async (request) => {
  const merchant = await requireUser(request);
  const { amount, asset, tag } = await body(
    request,
    z.object({ amount: amountField, asset: assetField.default('NGN'), tag: z.string().min(1).max(30) }),
  );
  return createRequest(merchant, amount, tag, asset);
});
