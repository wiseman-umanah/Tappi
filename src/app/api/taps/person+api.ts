import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { claimPersonTap } from '@/server/taps';

/** POST /api/taps/person { token } — this phone (on Receive) read a payer's phone. */
export const POST = route(async (request) => {
  const payee = await requireUser(request);
  const { token } = await body(request, z.object({ token: z.string().min(10).max(200) }));
  return claimPersonTap(payee, token);
});
