import { z } from 'zod';

import { verifyPin } from '@/server/auth';
import { body, pinField, requireUser, route } from '@/server/http';

/** POST /api/me/pin/check { pin } — the first step of changing a PIN (counts toward the lockout). */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { pin } = await body(request, z.object({ pin: pinField }));
  await verifyPin(user, pin);
});
