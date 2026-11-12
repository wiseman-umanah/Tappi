import { z } from 'zod';

import { signInWithPollar } from '@/server/auth';
import { body, route } from '@/server/http';
import { me } from '@/server/wallet';

/**
 * POST /api/auth/pollar { token } → { token, ...me }. `token` is the access token of the Pollar
 * session the app just signed in with (Pollar sent the email code). Tappi checks it with Pollar and
 * answers with a Tappi session. Called again when the Pollar wallet becomes ready, to link it.
 */
export const POST = route(async (request) => {
  const { token } = await body(request, z.object({ token: z.string().min(20).max(8_000) }));
  const { token: session, user } = await signInWithPollar(token);
  return { token: session, ...(await me(user)) };
});
