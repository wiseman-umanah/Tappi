import { z } from 'zod';

import { setReceiving } from '@/server/account';
import { verifyPin } from '@/server/auth';
import { body, pinField, requireUser, route } from '@/server/http';
import { me } from '@/server/wallet';

/** POST /api/me/receiving { enabled, pin } — disable or re-enable the account for incoming money. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { enabled, pin } = await body(request, z.object({ enabled: z.boolean(), pin: pinField }));
  await verifyPin(user, pin);
  return me(await setReceiving(user, enabled));
});
