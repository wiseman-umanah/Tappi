import { speechReady } from '@/server/ai/speech';
import { requireUser, route } from '@/server/http';

/** GET /api/ai/speech/:id/ready — waits for a reply's voice; { ready: false } if none could be made. */
export const GET = route<{ id: string }>(async (request, { id }) => speechReady((await requireUser(request)).id, id));
