import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { api } from '@/lib/api';
import type { AnyAsset, SwapQuote } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';

const ASSETS: AnyAsset[] = ['NGN', 'USDT', 'USDC', 'BTC'];
const LABEL: Record<AnyAsset, string> = { NGN: 'Naira', USDT: 'USDT', USDC: 'USDC', BTC: 'Bitcoin' };

function AssetChips({ value, onChange, exclude }: { value: AnyAsset; onChange: (a: AnyAsset) => void; exclude?: AnyAsset }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {ASSETS.filter((a) => a !== exclude).map((a) => (
        <Pressable
          key={a}
          onPress={() => onChange(a)}
          accessibilityRole="radio"
          accessibilityState={{ selected: a === value }}
          className={cn('rounded-full border px-3.5 py-2', a === value ? 'border-primary bg-primary-900' : 'border-border-tertiary bg-surface-2')}>
          <Text className="text-xs">{LABEL[a]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** "1 USDT = ₦1,560.25" from a quote, whichever way round reads naturally. */
function rateText(q: SwapQuote) {
  const big = q.from === 'NGN' || (q.from !== 'BTC' && q.to === 'BTC') ? 'to' : 'from';
  const [unit, other, unitAmount, otherAmount] = big === 'to' ? [q.to, q.from, q.receive, q.send] : [q.from, q.to, q.send, q.receive];
  return `1 ${unit} ≈ ${money(otherAmount / unitAmount, other)}`;
}

/** Swaps between naira, USDT, USDC and Bitcoin at a live Bitnob rate, then the PIN. */
export default function SwapScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [from, setFrom] = useState<AnyAsset>('NGN');
  const [to, setTo] = useState<AnyAsset>('USDT');
  const [amount, setAmount] = useState('');
  const value = useDebounced(amount, 600);
  const balance = me.data?.wallet?.balances[from] ?? 0;
  const tooMuch = Number(amount) > balance;
  const quote = useQuery({
    queryKey: ['swap-quote', from, to, value],
    queryFn: () => api<SwapQuote>('/swap/quote', { body: { from, to, amount: value } }),
    enabled: Number(value) > 0 && !tooMuch && from !== to,
    retry: false,
    gcTime: 0,
  });
  // Seconds left on the rate (Bitnob's quotes last seconds in production).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const q = quote.data && quote.data.from === from && quote.data.to === to ? quote.data : null;
  const secondsLeft = q ? Math.max(0, Math.floor((new Date(q.expiresAt).getTime() - now) / 1000)) : 0;
  const fresh = Boolean(q) && secondsLeft > 1 && amount === value;

  const pickFrom = (a: AnyAsset) => {
    if (a === to) setTo(from);
    setFrom(a);
    setAmount('');
  };
  const flip = () => {
    setFrom(to);
    setTo(from);
    setAmount('');
  };
  const next = () => {
    if (!q) return;
    router.push({
      pathname: '/approve',
      params: { action: 'swap', quoteId: q.quoteId, asset: q.from, amount: String(q.send), toAsset: q.to, receive: String(q.receive), name: LABEL[q.to] },
    });
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="Swap" />
      </View>
      <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
        <Text className="mb-2 mt-6 text-xs text-content-tertiary">From</Text>
        <AssetChips value={from} onChange={pickFrom} />
        <View className="mt-8">
          <MoneyInput asset={from} value={amount} onChangeText={setAmount} />
          <Pressable onPress={() => setAmount(String(balance))} hitSlop={8} className="mt-2 self-center">
            <Text className={tooMuch ? 'text-xs text-content-negative' : 'text-xs text-content-tertiary'}>
              {tooMuch ? 'More than your balance' : `Balance ${money(balance, from)} · `}
              {!tooMuch ? <Text className="text-xs text-primary">Use max</Text> : null}
            </Text>
          </Pressable>
        </View>

        <Pressable onPress={flip} accessibilityLabel="Swap direction" className="mt-6 h-9 w-9 items-center justify-center self-center rounded-full bg-surface-3">
          <Icon name="arrow-up-down-line" size={18} />
        </Pressable>

        <Text className="mb-2 mt-4 text-xs text-content-tertiary">To</Text>
        <AssetChips value={to} onChange={setTo} exclude={from} />

        <View className="mt-6 rounded-2xl bg-surface-2 p-4">
          <Text className="text-xs text-content-tertiary">You get</Text>
          <Text weight="bold" className="mt-1 text-2xl">
            {q && amount === value ? money(q.receive, q.to) : '—'}
          </Text>
          <Text className="mt-2 text-xs text-content-tertiary">
            {quote.isError
              ? quote.error.message
              : q && amount === value
                ? secondsLeft > 1
                  ? `${q.test ? 'Test rate · ' : ''}${rateText(q)} · rate held ${secondsLeft}s`
                  : 'Rate expired'
                : quote.isFetching
                  ? 'Getting the best rate…'
                  : 'Enter an amount to see the rate'}
          </Text>
          {q && amount === value && secondsLeft <= 1 ? (
            <Pressable onPress={() => quote.refetch()} className="mt-3 self-start">
              <Text className="text-sm text-primary">Refresh rate</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Button label="Continue" onPress={next} disabled={!fresh || tooMuch} />
      </View>
    </KeyboardAvoidingView>
  );
}
