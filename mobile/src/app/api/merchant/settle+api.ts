import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { body, pinField, requireUser, route } from '@/server/http';
import { settle } from '@/server/merchant';

/** POST /api/merchant/settle { pin } — testnet stand-in for an instant bank payout. */
export const POST = route(async (request) => {
  const merchant = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField }));
  await verifyPin(merchant, pin);
  return settle(merchant);
});
