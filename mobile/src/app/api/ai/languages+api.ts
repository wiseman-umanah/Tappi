import { listLanguages } from '@/server/ai/languages';
import { route } from '@/server/http';

/** GET /api/ai/languages — what Tappi AI can speak (Profile → Tappi AI language). */
export const GET = route(async () => listLanguages());
