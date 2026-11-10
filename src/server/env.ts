// Server-only. Read lazily so scripts and builds don't fail on variables they never use.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} — see .env.example`);
  return value;
}

export const env = {
  get walletEncryptionKey() {
    return required('WALLET_ENCRYPTION_KEY');
  },
  get sessionSecret() {
    return required('SESSION_SECRET');
  },
  get horizonUrl() {
    return process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  },
  get usdcIssuer() {
    return process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  },
  get treasurySecret() {
    return required('TREASURY_SECRET');
  },
  get ngnIssuerSecret() {
    return required('NGN_ISSUER_SECRET');
  },
  get marketMakerSecret() {
    return required('MARKET_MAKER_SECRET');
  },
  /** NGN per USDC the testnet market maker quotes. */
  get ngnPerUsdc() {
    return Number(process.env.NGN_PER_USDC || 1569);
  },
};
