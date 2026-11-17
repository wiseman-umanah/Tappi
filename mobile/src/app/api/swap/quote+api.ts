import { assetField, amountField, requireUser, route } from '@/server/http';
import { quote } from '@/server/wallet';

/** GET /api/swap/quote?from=NGN&amount=10000 */
export const GET = route(async (request) => {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  return quote(assetField.parse(params.get('from')), amountField.parse(params.get('amount')));
});
