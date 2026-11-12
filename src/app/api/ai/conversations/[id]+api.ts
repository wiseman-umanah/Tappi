import { deleteConversation, getConversation } from '@/server/ai/assistant';
import { requireUser, route } from '@/server/http';

/** GET /api/ai/conversations/:id — one chat and its messages. */
export const GET = route<{ id: string }>(async (request, { id }) => getConversation(await requireUser(request), id));

/** DELETE /api/ai/conversations/:id — delete a chat. */
export const DELETE = route<{ id: string }>(async (request, { id }) => deleteConversation(await requireUser(request), id));
