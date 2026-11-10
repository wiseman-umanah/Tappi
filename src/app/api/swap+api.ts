import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { amountField, assetField, body, pinField, requireUser, route } from '@/server/http';
import { swap } from '@/server/wallet';

/** POST /api/swap { from, amount, pin } */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const input = await body(request, z.object({ from: assetField, amount: amountField, pin: pinField }));
  await verifyPin(user, input.pin);
  return swap(user, input.from, input.amount);
});
