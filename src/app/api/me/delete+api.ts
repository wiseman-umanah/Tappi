import { z } from 'zod';

import { deleteAccount } from '@/server/account';
import { verifyPin } from '@/server/auth';
import { body, pinField, requireUser, route } from '@/server/http';

/** POST /api/me/delete { pin } — signs out everywhere; restorable for 30 days (see account.ts). */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField }));
  await verifyPin(user, pin);
  return deleteAccount(user);
});
