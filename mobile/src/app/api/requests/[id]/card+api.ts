import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { CARD_BRANDS, payByCard } from '@/server/merchant';

/** POST /api/requests/:id/card { brand } — a bank card tapped the merchant's phone (simulated charge). */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const merchant = await requireUser(request);
  const { brand } = await body(request, z.object({ brand: z.enum(CARD_BRANDS) }));
  return payByCard(merchant, id, brand);
});
