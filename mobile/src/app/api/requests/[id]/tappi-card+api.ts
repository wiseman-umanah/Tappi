import { z } from 'zod';

import { payWithCard } from '@/server/cards';
import { body, requireUser, route } from '@/server/http';

/** POST /api/requests/:id/tappi-card { token } — the merchant's phone read a customer's Tappi card. */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const merchant = await requireUser(request);
  const { token } = await body(request, z.object({ token: z.string().min(10).max(120) }));
  return payWithCard(merchant, id, token);
});
