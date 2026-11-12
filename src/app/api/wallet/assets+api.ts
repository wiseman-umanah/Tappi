import { route } from '@/server/http';
import { ngn, usdc } from '@/server/stellar/config';

/** GET /api/wallet/assets — the NGN and USDC issuers, for the app to add trustlines through Pollar. */
export const GET = route(async () => ({ NGN: ngn().getIssuer(), USDC: usdc().getIssuer() }));
