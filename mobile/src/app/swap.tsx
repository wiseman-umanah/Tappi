import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import type { Asset } from '@/lib/api-types';
import { naira, usd } from '@/lib/format';
import { useMe, useQuote } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';

const DIRECTIONS = [
  { key: 'NGN', label: 'Naira → USDC' },
  { key: 'USDC', label: 'USDC → Naira' },
] as const;

const fmt = (asset: Asset, n: number) => (asset === 'NGN' ? naira(n) : `${usd(n)} USDC`);

export default function SwapScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [from, setFrom] = useState<Asset>('NGN');
  const [amount, setAmount] = useState('');
  const value = Number(amount) || 0;
  const quote = useQuote(from, useDebounced(value, 400));
  const to: Asset = from === 'NGN' ? 'USDC' : 'NGN';
  const balance = me.data?.wallet?.balances[from] ?? 0;
  const tooMuch = value > balance;
  const fresh = quote.data && quote.data.amount === value;

  const next = () => {
    const q = quote.data;
    if (!q) return;
    router.push({ pathname: '/approve', params: { action: 'swap', from, amount: String(value), receive: String(q.receive) } });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="Swap" />
      </View>
      <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
        <SegmentedTabs
          tabs={DIRECTIONS}
          value={from}
          onChange={(key) => {
            setFrom(key);
            setAmount('');
          }}
          className="mt-6"
        />
        <View className="mt-10">
          <MoneyInput asset={from} value={amount} onChangeText={setAmount} />
          <Pressable onPress={() => setAmount(String(Math.floor(balance * 100) / 100))} hitSlop={8} className="mt-2 self-center">
            <Text className={tooMuch ? 'text-xs text-content-negative' : 'text-xs text-content-tertiary'}>
              {tooMuch ? 'More than your balance' : `Balance ${fmt(from, balance)} · `}
              {!tooMuch ? <Text className="text-xs text-primary">Use max</Text> : null}
            </Text>
          </Pressable>
        </View>

        <View className="mt-8 items-center">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-3">
            <Icon name="arrow-down-line" size={18} />
          </View>
        </View>

        <View className="mt-4 rounded-2xl bg-surface-2 p-4">
          <Text className="text-xs text-content-tertiary">You get</Text>
          <Text weight="bold" className="mt-1 text-2xl">
            {value > 0 && fresh ? fmt(to, quote.data.receive) : '—'}
          </Text>
          <Text className="mt-2 text-xs text-content-tertiary">
            {quote.isError
              ? quote.error.message
              : fresh
                ? `Rate ${naira(quote.data.rate)} per USDC · settles on Stellar`
                : value > 0
                  ? 'Getting the best rate…'
                  : 'Enter an amount to see the rate'}
          </Text>
        </View>
      </ScrollView>
      <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Button label="Continue" onPress={next} disabled={!fresh || tooMuch || value <= 0} />
      </View>
    </KeyboardAvoidingView>
  );
}
