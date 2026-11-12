import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { assetField, body, pinField, requireUser, route } from '@/server/http';
import { preparePay } from '@/server/merchant';

/** POST /api/requests/:idOrCode/pay { pin, asset, channel } → { id, xdr } to sign, then POST /api/tx/:id. */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const user = await requireUser(request);
  const input = await body(
    request,
    z.object({ pin: pinField, asset: assetField.default('NGN'), channel: z.enum(['nfc', 'qr', 'code', 'nearby']).default('qr') }),
  );
  await verifyPin(user, input.pin);
  return preparePay(user, id, input.asset, input.channel);
});
