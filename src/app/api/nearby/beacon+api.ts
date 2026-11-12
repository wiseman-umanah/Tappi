import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { endBeacon, issueBeacon } from '@/server/nearby';

/** POST /api/nearby/beacon { requestId? } — a Bluetooth beacon id for this phone to announce. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { requestId } = await body(request, z.object({ requestId: z.uuid().nullish() }));
  return issueBeacon(user, requestId);
});

/** DELETE /api/nearby/beacon — stop being findable. */
export const DELETE = route(async (request) => endBeacon(await requireUser(request)));
