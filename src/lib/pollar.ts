import { PollarClient } from '@pollar/core';
import { createSecureStoreAdapter } from '@pollar/core/adapters/expo';
import { createAppStateVisibilityProvider } from '@pollar/core/adapters/react-native-appstate';
import { Platform } from 'react-native';

import { api } from '@/lib/api';
import type { Prepared } from '@/lib/api-types';
import { createPollarFlow, PollarSessionError } from '@/lib/pollar-flow';

/**
 * The phone's side of Pollar: one client, its session kept in SecureStore so it survives restarts.
 * What it does with it lives in pollar-flow.ts.
 *
 * `EXPO_PUBLIC_POLLAR_KEY` is the app's publishable key (pub_testnet_…) from dashboard.pollar.xyz,
 * with "Allow native clients" on. What Pollar needs that Hermes lacks is set up in polyfills.ts.
 */
const API_KEY = process.env.EXPO_PUBLIC_POLLAR_KEY ?? '';

let client: Promise<PollarClient> | null = null;
let onSessionLost: (() => void) | null = null;

function getPollar(): Promise<PollarClient> {
  if (!API_KEY) return Promise.reject(new Error('Sign-in isn’t set up in this build (no Pollar key).'));
  if (!client) {
    client = (async () => {
      // SecureStore keeps the session; AppState lets the SDK refresh it when the app comes back.
      const native = Platform.OS !== 'web';
      const [storage, visibilityProvider] = native
        ? await Promise.all([createSecureStoreAdapter(), createAppStateVisibilityProvider()])
        : [undefined, undefined];
      const pollar = new PollarClient({
        apiKey: API_KEY,
        stellarNetwork: 'testnet',
        ...(storage ? { storage } : {}),
        ...(visibilityProvider ? { visibilityProvider } : {}),
      });
      await pollar.ready();
      return pollar;
    })();
    // A failed start (no storage, say) is retried on the next call.
    client.catch(() => {
      client = null;
    });
  }
  return client;
}

const flow = createPollarFlow(getPollar, api);

/** The Pollar session ended: Tappi can't sign anything without it, so sign out here too. */
function guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof PollarSessionError) onSessionLost?.();
      throw error;
    }
  };
}

/** `onSessionLost` runs when Pollar has signed the user out (SessionProvider signs out of Tappi). */
export function configurePollar(options: { onSessionLost: () => void }) {
  onSessionLost = options.onSessionLost;
}

export const sendSignInCode = flow.sendSignInCode;
export const verifySignInCode = flow.verifySignInCode;
export const linkWallet = guard(flow.linkWallet);
export const setupWallet = guard(flow.setupWallet);
export const signAndSubmit = guard(flow.signAndSubmit) as <T>(prepared: Prepared) => Promise<T>;

export async function signOutOfPollar() {
  // Nothing to sign out of if Pollar was never started in this run and has no stored session.
  if (!API_KEY) return;
  await flow.signOut();
}
