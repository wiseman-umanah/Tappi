import { listConversations } from '@/server/ai/assistant';
import { requireUser, route } from '@/server/http';

/** GET /api/ai/conversations — the user's Tappi AI chats, most recent first. */
export const GET = route(async (request) => listConversations(await requireUser(request)));
