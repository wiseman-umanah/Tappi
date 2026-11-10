import { requireUser, route } from '@/server/http';
import { lookupHandle } from '@/server/wallet';

/** GET /api/users/:handle — who you're about to send to. */
export const GET = route<{ handle: string }>(async (request, { handle }) => {
  await requireUser(request);
  return lookupHandle(handle);
});
