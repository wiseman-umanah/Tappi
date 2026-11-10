import { requireUser, route } from '@/server/http';
import { dashboard } from '@/server/merchant';

/** GET /api/merchant — transactions, analytics and payout balance. */
export const GET = route(async (request) => dashboard(await requireUser(request)));
