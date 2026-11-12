import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { amountField, assetField, body, pinField, requireUser, route } from '@/server/http';
import { prepareSend } from '@/server/wallet';

/** POST /api/send { to, asset, amount, pin } → { id, xdr } for the phone to sign, then POST /api/tx/:id. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const input = await body(
    request,
    z.object({ to: z.string().min(1, 'Enter a username'), asset: assetField, amount: amountField, pin: pinField }),
  );
  await verifyPin(user, input.pin);
  return prepareSend(user, input.to, input.asset, input.amount);
});
