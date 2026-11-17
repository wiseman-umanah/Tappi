import { VoiceInput, voiceTurn } from '@/server/ai/voice';
import { body, requireUser, route } from '@/server/http';

/** POST /api/ai/voice { audio (base64), format, conversationId?, speak? } — a spoken message to Tappi AI. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  return voiceTurn(user, await body(request, VoiceInput));
});
