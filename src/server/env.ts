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
  // ─── Pollar (sign-in and user wallets) ───
  /** Secret key (sec_testnet_… / sec_mainnet_…) for Pollar's Server API: verifies sign-ins. */
  get pollarSecretKey() {
    return required('POLLAR_SECRET_KEY');
  },
  get pollarServerUrl() {
    return process.env.POLLAR_SERVER_URL || 'https://server.api.pollar.xyz';
  },
  // ─── Tappi AI ───
  /** Groq: Whisper (speech → text), the chat model and Orpheus (English voice). */
  get groqApiKey() {
    return required('GROQ_API_KEY');
  },
  get aiModel() {
    return process.env.AI_MODEL || 'openai/gpt-oss-120b';
  },
  get whisperModel() {
    return process.env.WHISPER_MODEL || 'whisper-large-v3';
  },
  get orpheusModel() {
    return process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english';
  },
  /** Intron Sahara: African-language voices. Without a key every reply is voiced by Orpheus. */
  get intronApiKey() {
    return process.env.INTRON_API_KEY || null;
  },
  get intronBaseUrl() {
    return process.env.INTRON_BASE_URL || 'https://infer.voice.intron.io';
  },
  /** Seconds each voice provider gets (Sahara, then Orpheus) before a reply goes without audio. */
  get ttsTimeoutMs() {
    return Number(process.env.TTS_TIMEOUT_S || 12) * 1000;
  },
};
