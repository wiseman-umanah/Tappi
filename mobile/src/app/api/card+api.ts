import { z } from 'zod';

import { DAILY_LIMITS, getCard, updateCard } from '@/server/cards';
import { assetField, body, requireUser, route } from '@/server/http';

/** GET /api/card — the user's Tappi card (masked), its settings and today's spending. */
export const GET = route(async (request) => getCard(await requireUser(request)));

/** PATCH /api/card { frozen?, dailyLimit?, fundingAsset? } */
export const PATCH = route(async (request) => {
  const user = await requireUser(request);
  const input = await body(
    request,
    z.object({
      frozen: z.boolean().optional(),
      dailyLimit: z
        .number()
        .refine((n) => (DAILY_LIMITS as readonly number[]).includes(n), 'Pick one of the limits')
        .optional(),
      fundingAsset: assetField.optional(),
    }),
  );
  return updateCard(user, input);
});
