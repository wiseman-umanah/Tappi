import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Settings that belong to this phone, not the account (Cards → Tap preferences, the Wallet's
 * second balance card). Kept in
 * SecureStore (localStorage in the browser) and readable synchronously by non-React code such as
 * tapFeedback().
 */
export type Preferences = {
  /** Fingerprint / face / phone lock before the Tappi card can be tapped. */
  unlockBeforeTap: boolean;
  /** Sounds and haptics for taps and payments. */
  tapSound: boolean;
  /** Which non-naira balance the Wallet's second card shows. */
  walletAsset: 'USDC' | 'USDT' | 'BTC';
};

const KEY = 'tappi.preferences';
const DEFAULTS: Preferences = { unlockBeforeTap: true, tapSound: true, walletAsset: 'USDC' };

let current: Preferences = DEFAULTS;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const store = {
  get: async () => {
    if (Platform.OS !== 'web') return SecureStore.getItemAsync(KEY);
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (value: string) => {
    if (Platform.OS !== 'web') return SecureStore.setItemAsync(KEY, value);
    try {
      localStorage.setItem(KEY, value);
    } catch {}
  },
};

// Loaded once at startup; until then the defaults apply.
store
  .get()
  .then((saved) => {
    if (!saved) return;
    current = { ...DEFAULTS, ...(JSON.parse(saved) as Partial<Preferences>) };
    notify();
  })
  .catch(() => {});

export const getPreferences = () => current;

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  current = { ...current, [key]: value };
  notify();
  store.set(JSON.stringify(current)).catch(() => {});
}

export function usePreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPreferences,
    getPreferences,
  );
}
