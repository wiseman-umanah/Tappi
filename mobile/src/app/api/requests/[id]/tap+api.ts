import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { claimTap } from '@/server/taps';

/** POST /api/requests/:id/tap { token } — the merchant's phone read a customer's phone. */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const merchant = await requireUser(request);
  const { token } = await body(request, z.object({ token: z.string().min(10).max(200) }));
  return claimTap(merchant, id, token);
});
