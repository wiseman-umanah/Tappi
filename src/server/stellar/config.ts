import { Asset, Horizon, Keypair, Networks } from '@stellar/stellar-sdk';

import { env } from '../env';

// Testnet only.
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const EXPLORER = 'https://testnet.stellarchain.io';

let server: Horizon.Server | null = null;

export function horizon() {
  server ??= new Horizon.Server(env.horizonUrl);
  return server;
}

export const XLM = Asset.native();
/** Circle's testnet USDC. */
export const usdc = () => new Asset('USDC', env.usdcIssuer);
/** Test naira issued by Tappi's own issuer account — there is no naira anchor on testnet. */
export const ngn = () => new Asset('NGN', ngnIssuerKeypair().publicKey());

export type AssetCode = 'NGN' | 'USDC';
export const assetFor = (code: AssetCode) => (code === 'NGN' ? ngn() : usdc());

/** Sponsors account reserves and pays every fee (fee-bump), so users never hold XLM. */
export const treasuryKeypair = () => Keypair.fromSecret(env.treasurySecret);
export const ngnIssuerKeypair = () => Keypair.fromSecret(env.ngnIssuerSecret);
/** Keeps NGN/USDC offers on the testnet exchange so swaps have liquidity. */
export const marketMakerKeypair = () => Keypair.fromSecret(env.marketMakerSecret);

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const accountUrl = (publicKey: string) => `${EXPLORER}/account/${publicKey}`;

// Stellar amounts carry 7 decimal places.
export const amount7 = (n: number) => (Math.floor(n * 1e7) / 1e7).toFixed(7);
