import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { Me } from '@/lib/api-types';
import { linkWallet, setupWallet } from '@/lib/pollar';

const RETRY_MS = 4_000;

export type WalletSetupState = 'ready' | 'working' | { error: string };

const isReady = (me: Me | undefined) =>
  Boolean(me?.wallet?.setup.onChain && !me.wallet.setup.missing.length && me.wallet.setup.welcomed);

/**
 * After sign-in: links the Pollar wallet (if it wasn't there at sign-in), then walks the server's
 * setup — account opened, NGN and USDC trustlines signed here through Pollar, welcome money paid.
 * One step per pass; retries until the wallet is ready.
 */
export function useWalletSetup(me: Me | undefined, enabled: boolean): WalletSetupState {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = isReady(me);
  const linked = Boolean(me?.wallet);
  const known = me != null;

  useEffect(() => {
    if (!enabled || !known || ready) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const next = linked ? await setupWallet() : await linkWallet();
        if (!active) return;
        setError(null);
        queryClient.setQueryData(['me'], next);
        // Money arrived: refresh what shows it.
        if (isReady(next)) void queryClient.invalidateQueries({ queryKey: ['activity'] });
        // Linked but not ready (or still not linked): the changed `me` re-runs this, else wait.
        else if (Boolean(next.wallet) === linked) timer = setTimeout(() => active && setAttempt((n) => n + 1), RETRY_MS);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Wallet setup failed.');
        timer = setTimeout(() => active && setAttempt((n) => n + 1), RETRY_MS * 2);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, known, ready, linked, attempt, queryClient]);

  if (!known || ready) return 'ready';
  return error ? { error } : 'working';
}
