import { z } from 'zod';

import { converse } from '@/server/ai/assistant';
import { body, requireUser, route } from '@/server/http';

/** POST /api/ai/chat { text, conversationId?, speak? } — a typed message; no id starts a new chat. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { text, conversationId, speak } = await body(
    request,
    z.object({ text: z.string().trim().min(1).max(2000), conversationId: z.uuid().nullish(), speak: z.boolean().optional() }),
  );
  return converse(user, text, { conversationId, speak });
});
