import { z } from 'zod';

import { body, requireUser, route } from '@/server/http';
import { submitSigned } from '@/server/transactions';

/**
 * POST /api/tx/:id { signedXdr } — a transaction Tappi prepared, signed on the phone through
 * Pollar. Tappi checks it's unchanged, pays the fee and submits it.
 */
export const POST = route<{ id: string }>(async (request, { id }) => {
  const user = await requireUser(request);
  const { signedXdr } = await body(request, z.object({ signedXdr: z.string().min(40).max(20_000) }));
  return submitSigned(user, id, signedXdr);
});
