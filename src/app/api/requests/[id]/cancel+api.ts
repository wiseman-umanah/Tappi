import { requireUser, route } from '@/server/http';
import { cancelRequest } from '@/server/merchant';

export const POST = route<{ id: string }>(async (request, { id }) => {
  await cancelRequest(await requireUser(request), id);
});
