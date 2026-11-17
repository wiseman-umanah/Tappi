import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { api, configureApi } from '@/lib/api';

const KEY = 'tappi.session';

// SecureStore (Keychain / Keystore) on phones; localStorage in the browser preview.
const store = {
  get: async () => {
    if (Platform.OS !== 'web') return SecureStore.getItemAsync(KEY);
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (value: string | null) => {
    if (Platform.OS !== 'web') {
      return value ? SecureStore.setItemAsync(KEY, value) : SecureStore.deleteItemAsync(KEY);
    }
    try {
      if (value) localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
    } catch {}
  },
};

type SessionState = {
  status: 'loading' | 'signedOut' | 'signedIn';
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionState['status']>('loading');

  const clear = useCallback(async () => {
    configureApi({ token: null });
    await store.set(null);
    queryClient.clear();
    setStatus('signedOut');
  }, [queryClient]);

  useEffect(() => {
    store.get().then((token) => {
      configureApi({ token, onUnauthorized: () => void clear() });
      setStatus(token ? 'signedIn' : 'signedOut');
    });
  }, [clear]);

  const value = useMemo<SessionState>(
    () => ({
      status,
      signIn: async (token) => {
        configureApi({ token });
        await store.set(token);
        setStatus('signedIn');
      },
      signOut: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        await clear();
      },
    }),
    [status, clear],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
