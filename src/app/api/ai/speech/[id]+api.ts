import { speechResponse } from '@/server/ai/speech';
import { requireUser, route } from '@/server/http';

/** GET /api/ai/speech/:id — a reply's voice (WAV). Ask …/ready first. */
export const GET = route<{ id: string }>(async (request, { id }) => speechResponse((await requireUser(request)).id, id));
