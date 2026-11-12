import { requireUser, route } from '@/server/http';
import { finishWalletSetup } from '@/server/wallet';

/**
 * POST /api/wallet/setup — the app added the NGN and USDC trustlines to the Pollar wallet: pay the
 * welcome money (once). Returns /api/me.
 */
export const POST = route(async (request) => finishWalletSetup(await requireUser(request)));
