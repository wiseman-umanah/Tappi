import { z } from 'zod';

import { linkPollarWallet } from '@/server/auth';
import { body, requireUser, route } from '@/server/http';
import { me } from '@/server/wallet';

/** POST /api/me/wallet { token } — link the Pollar wallet once it exists (token: Pollar access token). */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { token } = await body(request, z.object({ token: z.string().min(20).max(8_000) }));
  return me(await linkPollarWallet(user, token));
});
