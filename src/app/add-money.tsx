import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Asset, FundResult } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { tapFeedback } from '@/lib/feedback';
import { naira, usd } from '@/lib/format';
import { useRefreshMoney } from '@/lib/queries';

const OPTIONS: { asset: Asset; title: string; amount: string; note: string }[] = [
  { asset: 'NGN', title: 'Naira', amount: naira(50_000, 0), note: 'Stands in for a bank transfer' },
  { asset: 'USDC', title: 'USDC', amount: usd(50), note: "Circle's testnet USDC" },
];

/** Testnet "Add Money": the Tappi treasury sends test funds, in place of a bank deposit. */
export default function AddMoney() {
  const insets = useSafeAreaInsets();
  const refresh = useRefreshMoney();
  const fund = useMutation({
    mutationFn: (asset: Asset) => api<FundResult>('/wallet/fund', { body: { asset } }),
    onSuccess: () => {
      tapFeedback('success');
      refresh();
    },
    onError: () => tapFeedback('declined'),
  });

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar title="Add money" close />
      {fund.isSuccess ? (
        <View className="flex-1 items-center justify-center">
          <TapResult
            outcome="success"
            title="Money added"
            detail={`${fund.data.asset === 'NGN' ? naira(fund.data.amount, 0) : usd(fund.data.amount)} is in your wallet`}
          />
          <Button label="Done" onPress={() => router.back()} className="mt-10 self-stretch" />
        </View>
      ) : (
        <>
          <View className="mt-6 flex-row items-center gap-2">
            <Badge label="Testnet" tone="noticeOutline" />
            <Text className="flex-1 text-xs text-content-tertiary">Free test money, sent by Tappi on Stellar.</Text>
          </View>
          <View className="mt-6 gap-3">
            {OPTIONS.map((o) => (
              <Pressable
                key={o.asset}
                onPress={() => fund.mutate(o.asset)}
                disabled={fund.isPending}
                className={cn(
                  'flex-row items-center gap-4 rounded-2xl border border-border-tertiary bg-surface-2 p-4 active:bg-surface-3',
                  fund.isPending && fund.variables !== o.asset && 'opacity-50',
                )}>
                <View className={cn('h-11 w-11 items-center justify-center rounded-full', o.asset === 'USDC' ? 'bg-usdc' : 'bg-primary')}>
                  <Text weight="bold" className="text-base">
                    {o.asset === 'NGN' ? '₦' : '$'}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text weight="medium" className="text-base">
                    {`Add ${o.amount}`}
                  </Text>
                  <Text className="mt-0.5 text-xs text-content-tertiary">{`${o.title} · ${o.note}`}</Text>
                </View>
                {fund.isPending && fund.variables === o.asset ? (
                  <Text className="text-xs text-content-tertiary">Sending…</Text>
                ) : (
                  <Icon name="arrow-right-s-line" size={20} className="text-content-tertiary" />
                )}
              </Pressable>
            ))}
          </View>
          {fund.isError ? <Text className="mt-4 text-sm text-content-negative">{fund.error.message}</Text> : null}
        </>
      )}
    </View>
  );
}
