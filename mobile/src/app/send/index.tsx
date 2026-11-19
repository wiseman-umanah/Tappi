import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import type { Asset } from '@/lib/api-types';
import { naira, usd } from '@/lib/format';
import { useMe, useRecipient } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import colors from '@/theme/colors';

const ASSETS = [
  { key: 'NGN', label: 'Naira' },
  { key: 'USDC', label: 'USDC' },
] as const;

export default function SendScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  // `to` comes from Pay (a nearby person, or a phone that was tapped) or a tappi://send link.
  const params = useLocalSearchParams<{ to?: string }>();
  const [to, setTo] = useState(params.to ?? '');
  const [asset, setAsset] = useState<Asset>('NGN');
  const [amount, setAmount] = useState('');
  const recipient = useRecipient(useDebounced(to));
  const balance = me.data?.wallet?.balances[asset] ?? 0;
  const value = Number(amount) || 0;
  const isSelf = recipient.data?.handle === me.data?.user.handle;
  const tooMuch = value > balance;
  const canContinue = recipient.isSuccess && !isSelf && value > 0 && !tooMuch;

  const next = () => {
    const r = recipient.data;
    if (!r?.handle) return;
    router.push({ pathname: '/approve', params: { action: 'send', to: r.handle, name: r.name, asset, amount: String(value) } });
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="Send money" />
      </View>
      <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
        <Text className="mb-2 mt-6 text-xs text-content-tertiary">To</Text>
        <View className="flex-row items-center rounded-2xl border border-border-disabled bg-surface-1 px-4">
          <Text className="text-base text-content-tertiary">@</Text>
          <TextInput
            value={to}
            onChangeText={(t) => setTo(t.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            placeholder="username"
            placeholderTextColor={colors.content.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={!params.to}
            className="flex-1 py-4 font-sans text-base text-white"
          />
          <Pressable
            onPress={() => router.push('/pay')}
            accessibilityRole="button"
            accessibilityLabel="Find people nearby"
            hitSlop={6}
            className="flex-row items-center gap-1 rounded-full bg-primary-800 px-3 py-1.5">
            <Icon name="rfid-line" size={12} />
            <Text className="text-xs">Nearby</Text>
          </Pressable>
        </View>
        <View className="mt-3 min-h-[44px] justify-center">
          {recipient.isSuccess ? (
            <View className="flex-row items-center gap-3">
              <Avatar gender={recipient.data.gender} size={36} />
              <View>
                <Text weight="medium" className="text-sm">
                  {recipient.data.name}
                </Text>
                <Text className="text-xs text-content-tertiary">
                  {isSelf ? "That's you" : `@${recipient.data.handle} · Tappi user`}
                </Text>
              </View>
            </View>
          ) : recipient.isError ? (
            <Text className="text-xs text-content-negative">{recipient.error.message}</Text>
          ) : recipient.isFetching ? (
            <Text className="text-xs text-content-tertiary">Looking up…</Text>
          ) : null}
        </View>

        <SegmentedTabs tabs={ASSETS} value={asset} onChange={setAsset} className="mt-4" />
        <Pressable onPress={() => router.push('/crypto/send')} hitSlop={6} className="mt-3 flex-row items-center gap-1 self-center">
          <Icon name="bit-coin-line" size={12} className="text-primary" />
          <Text className="text-xs text-primary">Send crypto to an outside wallet</Text>
        </Pressable>
        <View className="mt-8">
          <MoneyInput asset={asset} value={amount} onChangeText={setAmount} />
          <Text className={tooMuch ? 'mt-2 text-center text-xs text-content-negative' : 'mt-2 text-center text-xs text-content-tertiary'}>
            {tooMuch ? 'More than your balance' : `Balance ${asset === 'NGN' ? naira(balance) : usd(balance)}`}
          </Text>
        </View>
      </ScrollView>
      <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Button label="Continue" onPress={next} disabled={!canContinue} />
      </View>
    </KeyboardAvoidingView>
  );
}
