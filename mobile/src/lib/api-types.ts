// Response shapes of the Tappi API (backend/api, Python). Kept by hand: when an endpoint changes in
// backend/api/src/tappi_api, change its type here too. Amounts are whole units (₦1250.5, 2.5 USDC).

export type Asset = 'NGN' | 'USDC';
/** Every balance the backend holds. The app shows NGN and USDC for now. */
export type AnyAsset = 'NGN' | 'USDT' | 'USDC' | 'BTC';
export type Gender = 'female' | 'male';
export type AccountStatus = 'active' | 'disabled' | 'deleting' | 'closed';
export type Channel = 'nfc' | 'qr' | 'code' | 'card' | 'nearby' | 'tappi_card';

export type Me = {
  user: { id: string; email: string | null; name: string | null; handle: string | null; gender: Gender | null; language: string };
  needsProfile: boolean;
  hasPin: boolean;
  account: { status: AccountStatus; deleteAfter: string | null; daysLeft: number | null; restoreDays: number };
  wallet: { balances: Record<AnyAsset, number> } | null;
};
export type Session = Me & { token: string };

export type Rate = { ngnPerUsd: number; indicative: boolean };

export type Entry = {
  id: string;
  kind: 'deposit' | 'payment_in' | 'payment_out' | 'swap' | 'refund_in' | 'refund_out' | 'settlement' | 'withdrawal' | 'closure';
  title: string;
  tag: string;
  asset: AnyAsset;
  amount: number;
  assetIn: AnyAsset | null;
  amountIn: number | null;
  channel: string | null;
  at: string;
  /** The engine's ledger entry. */
  reference: string;
};
export type Activity = {
  entries: Entry[];
  /** This month, naira only. */
  spending: { total: number; payments: number; tags: { tag: string; amount: number; percent: number }[] };
};

export type Recipient = { name: string; handle: string; gender: Gender | null };
export type HandleCheck = { handle: string; available: boolean; message: string; suggestions: string[] };

export type RequestState = 'pending' | 'paid' | 'refunded' | 'cancelled' | 'expired';
export type PaymentRequest = {
  id: string;
  code: string;
  amount: number;
  asset: Asset;
  tag: string;
  state: RequestState;
  expiresAt: string;
  link: string;
  merchant: { name: string; handle: string | null; gender: Gender | null };
  tapped: string | null;
  channel: Channel | null;
  cardBrand: string | null;
  reference: string | null;
};
export type PayResult = { reference: string; amount: number; asset: Asset; spent: number; payAsset: Asset; merchant: string };
export type CardBrand = 'Visa' | 'Mastercard' | 'Verve' | 'American Express' | 'Discover' | 'UnionPay' | 'JCB' | 'Card';
export type CardResult = { reference: string; amount: number; asset: Asset; brand: CardBrand };

export type MerchantPayment = {
  id: string;
  amount: number;
  asset: Asset;
  tag: string;
  status: 'Completed' | 'Refunded' | 'Failed';
  payer: string;
  channel: Channel | null;
  at: string;
  reference: string | null;
};
export type Dashboard = {
  payments: MerchantPayment[];
  /** Naira, with dollar sales at the indicative rate. */
  todayVolume: number;
  todayUsdc: number;
  todayTaps: number;
  /** The merchant's naira balance: what they can withdraw to a bank. */
  payoutBalance: number;
  weekly: { day: string; amount: number }[];
};

export type TapToken = { token: string; link: string; expiresAt: string };
export type TapClaim = { customer: string };
export type PendingTap = {
  charge: { code: string } | null;
  person: { handle: string; name: string; gender: Gender | null } | null;
};
export type PersonTap = { payer: string };
export type Beacon = { id: string; expiresAt: string };
export type Nearby = {
  kind: 'person' | 'merchant';
  beacon: string;
  name: string;
  handle: string;
  gender: Gender | null;
  charge: { code: string; amount: number; asset: Asset; tag: string } | null;
};

export type TappiCard = {
  last4: string;
  expiry: string;
  holder: string;
  frozen: boolean;
  /** Naira. */
  dailyLimit: number;
  fundingAsset: Asset;
  spentToday: number;
  limits: number[];
  armedUntil: string | null;
  lastPayment: { id: string; merchant: string; asset: Asset; amount: number; at: string } | null;
};
export type TappiCardDetails = { number: string; expiry: string; cvv: string };
export type ArmedCard = { link: string; armedUntil: string };
export type CardPaid = PayResult;

export type AiAction =
  | { kind: 'approve'; label: string; params: Record<string, string> }
  | { kind: 'open'; label: string; href: string };
export type AiMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  spoken: boolean;
  actions: AiAction[];
  at: string;
};
export type AiConversations = { conversations: { id: string; title: string; updatedAt: string }[] };
export type AiConversation = { id: string; title: string; messages: AiMessage[] };
export type AiTurn = {
  conversationId: string;
  title: string;
  question: AiMessage;
  reply: AiMessage;
  speechId: string | null;
};
export type AiLanguage = { code: string; label: string; native: string };
export type AiLanguages = { languages: AiLanguage[] };

/** The user's own NGN account number (Paga): transfers to it land in their naira balance. */
export type BankAccount = { accountNumber: string; accountName: string | null; bankName: string };
export type Bank = { uuid: string; name: string };
export type ResolvedAccount = { accountName: string | null };
/** A bank withdrawal. `pending` until the bank confirms; `failed` means the money came back. */
export type Withdrawal = { id: string; status: 'pending' | 'succeeded' | 'failed'; amount: number | null; error: string | null };

export type CryptoAsset = 'USDT' | 'USDC' | 'BTC';
export type CryptoNetwork = { chain: string; label: string };
export type CryptoNetworks = { networks: Record<CryptoAsset, CryptoNetwork[]> };
export type DepositAddress = { asset: CryptoAsset; chain: string; address: string };

/** A live swap rate (Bitnob). Exact amounts; valid until `expiresAt` (seconds away). */
export type SwapQuote = {
  quoteId: string;
  from: AnyAsset;
  to: AnyAsset;
  send: number;
  receive: number;
  expiresAt: string;
  /** Test money mode: a fixed test rate, not a market trade. */
  test: boolean;
};
export type SwapResult = { id: string; status: 'pending' | 'succeeded' | 'failed'; received: number | null; to: AnyAsset | null; error: string | null };

/** The Bitnob USD virtual Visa card (not the Tappi card). Amounts in US dollars. */
export type UsdCardFees = { creation: number; topupFlat: number; topupPercent: number; percentFrom: number };
export type UsdCardKycStatus = 'none' | 'initiated' | 'pending' | 'approved' | 'rejected';
export type UsdCard = {
  status: 'pending' | 'active' | 'frozen' | 'terminated' | 'failed';
  last4: string | null;
  name: string | null;
  fundingAsset: 'USDT' | 'USDC';
  balance: number;
};
export type UsdCardOverview = {
  kyc: { status: UsdCardKycStatus; reason: string | null };
  card: UsdCard | null;
  /** What the engine charges (configurable there), in dollars. */
  fees: UsdCardFees;
};
export type UsdCardDetails = { number: string; cvv: string; expiryMonth: string; expiryYear: string; name: string };
export type UsdCardTransaction = { id: string; type: string; status: string; amount: number; merchant: string | null; at: string };
