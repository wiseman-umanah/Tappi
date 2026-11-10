import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { me, updateProfile } from '@/server/wallet';

/** GET /api/me — the user, their wallet and live balances. */
export const GET = route(async (request) => me(await requireUser(request, { restoring: true })));

/** PATCH /api/me { name?, handle?, gender? } — completing the profile creates the wallet. */
export const PATCH = route(async (request) => {
  const user = await requireUser(request);
  const input = await body(
    request,
    z.object({
      name: z.string().trim().min(2, 'Enter your name').max(60).optional(),
      handle: z
        .string()
        .trim()
        .toLowerCase()
        .transform((h) => h.replace(/^@/, ''))
        .pipe(z.string().regex(/^[a-z0-9_]{3,20}$/, 'Username: 3–20 letters, numbers or _'))
        .optional(),
      gender: z.enum(['female', 'male']).optional(),
    }),
  );
  return me(await updateProfile(user, input));
});
