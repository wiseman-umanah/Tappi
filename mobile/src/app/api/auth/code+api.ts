import { z } from 'zod';

import { requestCode } from '@/server/auth';
import { body, route } from '@/server/http';

/** POST /api/auth/code { email } — on testnet the code comes back so the app can fill it in. */
export const POST = route(async (request) => {
  const { email } = await body(request, z.object({ email: z.email('Enter a valid email').toLowerCase().trim() }));
  return requestCode(email);
});
