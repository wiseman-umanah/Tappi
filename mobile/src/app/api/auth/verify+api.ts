import { z } from 'zod';

import { verifyCode } from '@/server/auth';
import { body, route } from '@/server/http';
import { me } from '@/server/wallet';

/** POST /api/auth/verify { email, code } → { token, ...me } */
export const POST = route(async (request) => {
  const { email, code } = await body(
    request,
    z.object({ email: z.email().toLowerCase().trim(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  );
  const { token, user } = await verifyCode(email, code);
  return { token, ...(await me(user)) };
});
