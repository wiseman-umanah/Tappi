import { requireUser, route } from '@/server/http';
import { getRequest } from '@/server/merchant';

/** GET /api/requests/:idOrCode — both phones poll this for the charge's state. */
export const GET = route<{ id: string }>(async (request, { id }) => {
  await requireUser(request);
  return getRequest(id);
});
