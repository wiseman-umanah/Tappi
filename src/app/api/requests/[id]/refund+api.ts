import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { body, pinField, requireUser, route } from '@/server/http';
import { prepareRefund } from '@/server/merchant';

/** POST /api/requests/:id/refund { pin } → { id, xdr } to sign, then POST /api/tx/:id. */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const merchant = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField }));
  await verifyPin(merchant, pin);
  return prepareRefund(merchant, id);
});
