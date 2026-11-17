import { checkHandle } from '@/server/handles';
import { requireUser, route } from '@/server/http';

/** GET /api/handles/:handle?name= — is this username free? Suggestions when it isn't. */
export const GET = route<{ handle: string }>(async (request, { handle }) => {
  const user = await requireUser(request);
  return checkHandle(user, handle, new URL(request.url).searchParams.get('name') ?? undefined);
});
