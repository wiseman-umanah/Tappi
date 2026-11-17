import { z } from 'zod';

import { setPin, verifyPin } from '@/server/auth';
import { body, HttpError, pinField, requireUser, route } from '@/server/http';

/** POST /api/me/pin { pin, currentPin? } — changing an existing PIN needs the current one. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { pin, currentPin } = await body(request, z.object({ pin: pinField, currentPin: pinField.optional() }));
  if (user.pinHash) {
    if (!currentPin) throw new HttpError(400, 'Enter your current PIN.');
    await verifyPin(user, currentPin);
    if (currentPin === pin) throw new HttpError(400, 'Choose a different PIN from your current one.');
  }
  await setPin(user.id, pin);
});
