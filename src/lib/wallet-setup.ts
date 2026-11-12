import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { Me } from '@/lib/api-types';
import { finishWalletSetup, linkWallet } from '@/lib/pollar';

const RETRY_MS = 4_000;

export type WalletSetupState = 'ready' | 'working' | { error: string };

/**
 * After sign-in: links the Pollar wallet if it wasn't ready at sign-in, waits for Pollar to put it
 * on-chain, adds the NGN and USDC trustlines and collects the welcome money. Retries until done.
 */
export function useWalletSetup(me: Me | undefined, enabled: boolean): WalletSetupState {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const done = Boolean(me?.wallet?.setup.onChain && !me.wallet.setup.missing.length && me.wallet.setup.welcomed);

  useEffect(() => {
    if (!enabled || !me || done) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = async () => {
      try {
        const next = me.wallet ? await finishWalletSetup(me) : await linkWallet();
        if (!active) return;
        setError(null);
        if (next) queryClient.setQueryData(['me'], next);
        // Not on-chain yet, or the wallet still isn't linked: ask again shortly.
        if (!next || !next.wallet?.setup.welcomed) timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['me'] }), RETRY_MS);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Wallet setup failed.');
        timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['me'] }), RETRY_MS * 3);
      }
    };
    void step();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, me, done, queryClient]);

  if (!me || done) return 'ready';
  return error ? { error } : 'working';
}
