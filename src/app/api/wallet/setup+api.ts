import { requireUser, route } from '@/server/http';
import { setupWallet } from '@/server/wallet';

/**
 * POST /api/wallet/setup → { me, sign } — gets the Pollar wallet ready, one step per call: opens
 * the account, hands back the trustline transaction to sign (`sign`, then POST /api/tx/:id), pays
 * the welcome money. The app repeats it until `sign` is null and `me.wallet.setup.welcomed`.
 */
export const POST = route(async (request) => setupWallet(await requireUser(request)));
