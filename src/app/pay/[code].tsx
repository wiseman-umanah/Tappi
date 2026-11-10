import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/icon';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import type { Asset } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { naira, usd } from '@/lib/format';
import { useMe, usePaymentRequest, useRate } from '@/lib/queries';

/** Customer confirms a merchant's charge, picks naira or USDC, then approves with their PIN. */
export default function ConfirmPayment() {
  const insets = useSafeAreaInsets();
  // `channel` comes from the in-app reader/scanner; `via` from a tappi:// link opened by Android
  // (NFC tap with Tappi closed) or the phone's camera app.
  const params = useLocalSearchParams<{ code: string; channel?: string; via?: string }>();
  const { code } = params;
  const channel = params.channel ?? (params.via === 'nfc' || params.via === 'qr' ? params.via : 'code');
  const request = usePaymentRequest(code, true);
  const me = useMe();
  const rate = useRate();
  const [asset, setAsset] = useState<Asset>('NGN');

  const r = request.data;
  const balances = me.data?.wallet?.balances;
  const usdcCost = r && rate.data ? (r.amount / rate.data) * 1.006 : null; // live rate + the maker's spread
  const options: { asset: Asset; label: string; detail: string; enough: boolean }[] = r
    ? [
        { asset: 'NGN', label: 'Naira balance', detail: naira(balances?.NGN ?? 0), enough: (balances?.NGN ?? 0) >= r.amount },
        {
          asset: 'USDC',
          label: 'USDC balance',
          detail: `${usd(balances?.USDC ?? 0)}${usdcCost ? ` · costs ≈ ${usd(usdcCost)}` : ''}`,
          enough: usdcCost != null && (balances?.USDC ?? 0) >= usdcCost,
        },
      ]
    : [];
  const chosen = options.find((o) => o.asset === asset);
  const isOwn = r?.merchant.handle === me.data?.user.handle;

  const pay = () => {
    if (!r) return;
    router.push({
      pathname: '/approve',
      params: { action: 'pay', code: r.code, amount: String(r.amount), name: r.merchant.name, asset, channel },
    });
  };

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar close onBack={() => router.dismissTo('/')} />
      {!r ? (
        <View className="flex-1 items-center justify-center">
          {request.isError ? (
            <>
              <TapResult outcome="declined" title="Charge not found" detail={request.error.message} />
              <Button label="Try again" onPress={() => router.replace('/pay')} className="mt-10 self-stretch" />
            </>
          ) : (
            <ActivityIndicator color="#FFFFFF" />
          )}
        </View>
      ) : r.state !== 'pending' ? (
        <View className="flex-1 items-center justify-center">
          <TapResult
            outcome={r.state === 'paid' ? 'success' : 'timeout'}
            title={r.state === 'paid' ? 'Already paid' : r.state === 'expired' ? 'Charge expired' : 'Charge closed'}
            detail={`${naira(r.amount)} · ${r.merchant.name}`}
          />
          <Button label="Done" onPress={() => router.dismissTo('/')} className="mt-10 self-stretch" />
        </View>
      ) : (
        <>
          <View className="flex-1 items-center justify-center">
            <Avatar gender={r.merchant.gender} size={64} />
            <Text className="mt-3 text-sm text-content-tertiary">{`Pay ${r.merchant.name}`}</Text>
            <Text weight="bold" className="mt-2 text-[40px]">
              {naira(r.amount)}
            </Text>
            <Text className="mt-1 text-xs text-content-tertiary">{`${r.tag} · code ${r.code}`}</Text>
          </View>

          <Text className="mb-2 text-xs text-content-tertiary">Pay with</Text>
          <View className="mb-5 gap-2">
            {options.map((o) => {
              const selected = o.asset === asset;
              return (
                <Pressable
                  key={o.asset}
                  onPress={() => setAsset(o.asset)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className={cn(
                    'flex-row items-center gap-3 rounded-2xl border bg-surface-2 px-4 py-3.5',
                    selected ? 'border-primary' : 'border-border-tertiary',
                  )}>
                  <View className={cn('h-9 w-9 items-center justify-center rounded-full', o.asset === 'USDC' ? 'bg-usdc' : 'bg-primary')}>
                    <Text weight="bold" className="text-sm">
                      {o.asset === 'NGN' ? '₦' : '$'}
                    </Text>
                  </View>
                  <View className="flex-1">
                    <Text weight="medium" className="text-sm">
                      {o.label}
                    </Text>
                    <Text className={cn('mt-0.5 text-[11px]', o.enough ? 'text-content-tertiary' : 'text-content-negative')}>
                      {o.enough ? o.detail : `Not enough · ${o.detail}`}
                    </Text>
                  </View>
                  <Icon name={selected ? 'radio-button-fill' : 'checkbox-blank-circle-line'} size={20} className={selected ? 'text-primary' : 'text-content-disabled'} />
                </Pressable>
              );
            })}
          </View>
          {isOwn ? <Text className="mb-3 text-center text-xs text-content-negative">This is your own charge.</Text> : null}
          <Button label={`Pay ${naira(r.amount)}`} onPress={pay} disabled={!chosen?.enough || isOwn} />
        </>
      )}
    </View>
  );
}
