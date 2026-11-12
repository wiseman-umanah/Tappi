import type { AuthState, PollarClient as Client } from '@pollar/core';
import { Platform } from 'react-native';

import { api, ApiError } from '@/lib/api';
import type { Asset, Me, Prepared, Session } from '@/lib/api-types';

/**
 * Pollar (https://docs.pollar.xyz) holds every user's Stellar wallet and signs users in (email code).
 * Tappi never holds the key: the server builds each transaction, this phone signs it through
 * Pollar, and the server checks it, pays the fee and submits it (src/server/stellar/user-tx.ts).
 *
 * `EXPO_PUBLIC_POLLAR_KEY` is the app's publishable key (pub_testnet_…) from dashboard.pollar.xyz.
 * The polyfills Pollar needs on Hermes are loaded first, in index.js.
 */
const API_KEY = process.env.EXPO_PUBLIC_POLLAR_KEY ?? '';

export const pollarConfigured = Boolean(API_KEY);

let client: Promise<Client> | null = null;
/** Transactions Tappi asked Pollar to sign: only these are confirmed without asking again. */
const expected = new Set<string>();

/** The one Pollar client (session kept in SecureStore, so it survives restarts). */
export function getPollar(): Promise<Client> {
  if (!API_KEY) return Promise.reject(new Error('Sign-in isn’t set up: add EXPO_PUBLIC_POLLAR_KEY (Pollar publishable key).'));
  client ??= (async () => {
    const { PollarClient } = await import('@pollar/core');
    const storage =
      Platform.OS === 'web' ? undefined : await (await import('@pollar/core/adapters/expo')).createSecureStoreAdapter();
    const pollar = new PollarClient({ apiKey: API_KEY, stellarNetwork: 'testnet', ...(storage ? { storage } : {}) });
    // Tappi already asked for the PIN (or the phone unlock, for the card) before it built the
    // transaction, so Pollar's own "confirm this signature?" step is answered here — but only for
    // the exact transaction Tappi is signing. Anything else is refused.
    pollar.onConfirmationRequest((pending) => {
      for (const request of pending) {
        if (request.unsignedXdr && expected.has(request.unsignedXdr)) request.confirm();
        else request.reject();
      }
    });
    await pollar.ready();
    return pollar;
  })();
  client.catch(() => {
    client = null;
  });
  return client;
}

// ---------------- Sign-in (Pollar email code) ----------------

/** Resolves when the auth state reaches one of `steps` (or fails on `error`). */
function waitFor(pollar: Client, steps: AuthState['step'][], timeoutMs = 45_000): Promise<AuthState> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('That took too long. Check your connection and try again.'));
    }, timeoutMs);
    unsubscribe = pollar.onAuthStateChange((state) => {
      if (state.step === 'error') {
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        reject(new Error(state.message || 'Sign-in failed. Try again.'));
      } else if (steps.includes(state.step)) {
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        resolve(state);
      }
    });
  });
}

/** Pollar emails a code to `email`. */
export async function sendSignInCode(email: string) {
  const pollar = await getPollar();
  // A Pollar session left from an earlier sign-in (e.g. Tappi's session expired) starts over.
  if (pollar.getAuthState().step === 'authenticated') pollar.logout();
  pollar.cancelLogin();
  pollar.beginEmailLogin();
  await waitFor(pollar, ['entering_email']);
  pollar.sendEmailCode(email);
  await waitFor(pollar, ['entering_code']);
}

/** Checks the code with Pollar, then signs in to Tappi with that Pollar session. */
export async function verifySignInCode(code: string): Promise<Session> {
  const pollar = await getPollar();
  pollar.verifyEmailCode(code);
  await waitFor(pollar, ['authenticated']);
  return linkTappi();
}

/** Hands the current Pollar session to Tappi: a Tappi session, with the Pollar wallet linked. */
export async function linkTappi(): Promise<Session> {
  const pollar = await getPollar();
  const state = pollar.getAuthState();
  if (state.step !== 'authenticated') throw new Error('Sign in again.');
  return api<Session>('/auth/pollar', { body: { token: state.session.token.accessToken } });
}

/** Links the Pollar wallet to the signed-in Tappi account once Pollar has created it. */
export async function linkWallet(): Promise<Me> {
  const pollar = await getPollar();
  await pollar.refreshWalletState();
  const state = pollar.getAuthState();
  if (state.step !== 'authenticated') throw new Error('Sign in again to set up your wallet.');
  return api<Me>('/me/wallet', { body: { token: state.session.token.accessToken } });
}

export async function signOutOfPollar() {
  if (!client) return;
  (await client.catch(() => null))?.logout();
}

// ---------------- Signing ----------------

/**
 * Signs a transaction Tappi prepared (through Pollar, without Pollar's fee sponsorship: Tappi's
 * treasury pays) and hands it back to Tappi to submit. Returns what the server recorded.
 */
export async function signAndSubmit<T>(prepared: Prepared): Promise<T> {
  const pollar = await getPollar();
  expected.add(prepared.xdr);
  try {
    const outcome = await pollar.signTx(prepared.xdr, { skipSponsorship: true });
    if (outcome.status === 'cosign_pending') {
      throw new Error('Approve this payment in the Pollar prompt on your phone, then try again.');
    }
    if (outcome.status !== 'signed') {
      throw new Error(outcome.details || 'Your wallet didn’t sign this payment. Try again.');
    }
    return await api<T>(`/tx/${prepared.id}`, { body: { signedXdr: outcome.signedXdr } });
  } finally {
    expected.delete(prepared.xdr);
  }
}

// ---------------- Wallet setup ----------------

/**
 * Pollar opens the wallet's Stellar account; this adds the NGN and USDC trustlines it still lacks
 * (through Pollar, which pays their reserve) and asks Tappi for the welcome money. Returns the
 * fresh /api/me, or null when the account isn't on-chain yet (Pollar is still creating it).
 */
export async function finishWalletSetup(me: Me): Promise<Me | null> {
  const wallet = me.wallet;
  if (!wallet) return null;
  if (!wallet.setup.onChain) return null;
  if (wallet.setup.missing.length) {
    const pollar = await getPollar();
    const issuers = await api<Record<Asset, string>>('/wallet/assets');
    for (const asset of wallet.setup.missing) {
      const result = await pollar.setTrustline({ code: asset, issuer: issuers[asset] });
      if (result.status === 'error') {
        throw new ApiError(502, `Couldn't add ${asset} to your wallet${'details' in result && result.details ? `: ${result.details}` : '.'}`);
      }
    }
  }
  return api<Me>('/wallet/setup', { method: 'POST' });
}
