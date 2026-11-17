import { z } from 'zod';

import { assetField, body, requireUser, route } from '@/server/http';
import { fund } from '@/server/wallet';

/** POST /api/wallet/fund { asset } — testnet "Add Money": the treasury sends test funds. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { asset } = await body(request, z.object({ asset: assetField }));
  return fund(user, asset);
});
