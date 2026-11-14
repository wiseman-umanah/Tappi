// Response shapes, taken straight from the server code. `import type` is erased at build time,
// so no server code reaches the app bundle.
import type { activity } from '@/server/activity';
import type { AiAction, converse, getConversation, listConversations } from '@/server/ai/assistant';
import type { listLanguages } from '@/server/ai/languages';
import type { dashboard, getRequest, payByCard, payTx, refundTx, settleTx } from '@/server/merchant';
import type { armCard, cardDetails, getCard, payWithCard } from '@/server/cards';
import type { checkHandle } from '@/server/handles';
import type { resolveBeacons, issueBeacon } from '@/server/nearby';
import type { claimPersonTap, claimTap, issueTapToken, pendingTap } from '@/server/taps';
import type { fund, lookupHandle, me, quote, sendTx, setupWallet, swapTx } from '@/server/wallet';
import type { Prepared } from '@/server/stellar/user-tx';

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type Me = Result<typeof me>;
export type Session = Me & { token: string };
/** One step of wallet setup: `sign` is a transaction for this phone to sign, when there is one. */
export type WalletSetup = Result<typeof setupWallet>;
export type Activity = Result<typeof activity>;
export type Entry = Activity['entries'][number];
export type Dashboard = Result<typeof dashboard>;
export type MerchantPayment = Dashboard['payments'][number];
export type PaymentRequest = Result<typeof getRequest>;
export type Recipient = Result<typeof lookupHandle>;
export type HandleCheck = Result<typeof checkHandle>;
export type Quote = Result<typeof quote>;
export type FundResult = Result<typeof fund>;
/** A transaction Tappi built for this phone to sign through Pollar (then POST /api/tx/:id). */
export type { Prepared };
export type SendResult = Result<typeof sendTx.done>;
export type SwapResult = Result<typeof swapTx.done>;
export type PayResult = Result<typeof payTx.done>;
export type RefundResult = Result<typeof refundTx.done>;
export type SettleResult = Result<typeof settleTx.done>;
export type CardResult = Result<typeof payByCard>;
export type CardBrand = CardResult['brand'];
export type TapToken = ReturnType<typeof issueTapToken>;
export type TapClaim = Result<typeof claimTap>;
export type PendingTap = Result<typeof pendingTap>;
export type PersonTap = Result<typeof claimPersonTap>;
export type Beacon = Result<typeof issueBeacon>;
export type Nearby = Result<typeof resolveBeacons>['nearby'][number];
export type AiConversations = Result<typeof listConversations>;
export type AiConversation = Result<typeof getConversation>;
export type AiMessage = AiConversation['messages'][number];
export type AiTurn = Result<typeof converse>;
export type { AiAction };
export type AiLanguages = ReturnType<typeof listLanguages>;
export type AiLanguage = AiLanguages['languages'][number];
export type TappiCard = Result<typeof getCard>;
export type TappiCardDetails = Result<typeof cardDetails>;
export type ArmedCard = Result<typeof armCard>;
export type CardPaid = Result<typeof payWithCard>;
export type Asset = 'NGN' | 'USDC';
export type Gender = 'female' | 'male';
