import { z } from 'zod';

import { cardDetails } from '@/server/cards';
import { body, pinField, requireUser, route } from '@/server/http';

/** POST /api/card/details { pin } — full number, expiry and CVV. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField }));
  return cardDetails(user, pin);
});
