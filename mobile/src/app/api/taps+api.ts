import { requireUser, route } from '@/server/http';
import { issueTapToken, pendingTap } from '@/server/taps';

/** POST /api/taps — a short-lived token the customer's phone presents over NFC. */
export const POST = route(async (request) => issueTapToken(await requireUser(request)));

/** GET /api/taps — the charge a merchant just tapped this customer into, if any. */
export const GET = route(async (request) => {
  const since = new Date(new URL(request.url).searchParams.get('since') ?? 0);
  return pendingTap(await requireUser(request), Number.isNaN(since.getTime()) ? new Date(0) : since);
});
