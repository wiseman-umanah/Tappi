import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { resolveBeacons } from '@/server/nearby';

/** POST /api/nearby/resolve { ids } — who is behind the beacon ids this phone heard. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { ids } = await body(request, z.object({ ids: z.array(z.string().max(32)).max(50) }));
  return resolveBeacons(user, ids);
});
