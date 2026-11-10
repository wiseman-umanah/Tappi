// Response shapes, taken straight from the server code. `import type` is erased at build time,
// so no server code reaches the app bundle.
import type { activity } from '@/server/activity';
import type { dashboard, getRequest, payRequest, refund, settle } from '@/server/merchant';
import type { checkHandle } from '@/server/handles';
import type { fund, lookupHandle, me, quote, send, swap } from '@/server/wallet';

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type Me = Result<typeof me>;
export type Session = Me & { token: string };
export type Activity = Result<typeof activity>;
export type Entry = Activity['entries'][number];
export type Dashboard = Result<typeof dashboard>;
export type MerchantPayment = Dashboard['payments'][number];
export type PaymentRequest = Result<typeof getRequest>;
export type Recipient = Result<typeof lookupHandle>;
export type HandleCheck = Result<typeof checkHandle>;
export type Quote = Result<typeof quote>;
export type FundResult = Result<typeof fund>;
export type SendResult = Result<typeof send>;
export type SwapResult = Result<typeof swap>;
export type PayResult = Result<typeof payRequest>;
export type RefundResult = Result<typeof refund>;
export type SettleResult = Result<typeof settle>;
export type Asset = 'NGN' | 'USDC';
export type Gender = 'female' | 'male';
