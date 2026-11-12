import { z } from 'zod';

import { armCard, disarmCard } from '@/server/cards';
import { body, pinField, requireUser, route } from '@/server/http';

/** POST /api/card/arm { pin? } — "Tap to pay": the card can be read for a minute. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField.optional() }));
  return armCard(user, pin);
});

/** DELETE /api/card/arm — stop presenting the card. */
export const DELETE = route(async (request) => disarmCard(await requireUser(request)));
