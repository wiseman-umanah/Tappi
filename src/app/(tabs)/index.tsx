import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { TAB_BAR_CLEARANCE, tabBarOffset } from '@/components/tab-bar';
import { Text } from '@/components/text';
import { ListCard } from '@/components/ui/list-card';
import { Toggle } from '@/components/ui/toggle';
import { TransactionRow, TransactionRowSkeleton } from '@/components/ui/transaction-row';
import { naira, nairaShort, usd, usdShort } from '@/lib/format';
import { useActivity, useMe, useRate, useRefreshMoney } from '@/lib/queries';
import { useWalletSetup } from '@/lib/wallet-setup';
import colors from '@/theme/colors';

// Design: design/screens/02-wallet-home.png
const QUICK_ACTIONS: { label: string; icon: IconName; href: Href }[] = [
  { label: 'Add Money', icon: 'add-line', href: '/add-money' },
  { label: 'Send', icon: 'send-plane-line', href: '/send' },
  { label: 'Swap', icon: 'arrow-left-right-line', href: '/swap' },
  { label: 'NFC Payment', icon: 'rfid-line', href: '/pay' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}

type BalanceCardProps = {
  label: string;
  amount: string;
  /** Exact amount, read out by screen readers when the card shows the short form. */
  exact: string;
  footnote: string;
  hidden: boolean;
  onToggleHidden: () => void;
};

function BalanceCard({ label, amount, exact, footnote, hidden, onToggleHidden }: BalanceCardProps) {
  return (
    <View className="flex-1 rounded-2xl bg-primary p-3.5">
      <Pressable onPress={onToggleHidden} hitSlop={8} className="flex-row items-center gap-1 self-start">
        <Text className="text-[10px]">{label}</Text>
        <Icon name={hidden ? 'eye-off-line' : 'eye-line'} size={11} />
      </Pressable>
      <Text
        weight="bold"
        className="mt-4 text-xl"
        numberOfLines={1}
        accessibilityLabel={hidden ? 'Balance hidden' : exact}>
        {hidden ? '••••••' : amount}
      </Text>
      <Text className="mt-3 text-[9px] text-white/80">{hidden ? ' ' : footnote}</Text>
    </View>
  );
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const activity = useActivity();
  const rate = useRate();
  const refresh = useRefreshMoney();
  const [refreshing, setRefreshing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [tapToPay, setTapToPay] = useState(true);
  const toggleHidden = () => setHidden((h) => !h);

  // The Pollar wallet: linked, on-chain, NGN + USDC added, welcome money in (src/lib/pollar.ts).
  const setup = useWalletSetup(me.data, true);
  const ngn = me.data?.wallet?.balances.NGN ?? 0;
  const usdc = me.data?.wallet?.balances.USDC ?? 0;
  const firstName = me.data?.user.name?.split(' ')[0] ?? '';
  const recents = activity.data?.entries.slice(0, 3);

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh().finally(() => setRefreshing(false));
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScrollView
        contentContainerClassName="px-5"
        contentContainerStyle={{ paddingBottom: TAB_BAR_CLEARANCE + tabBarOffset(insets.bottom) }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.white} />}>
        <View className="mb-5 mt-4">
          <Text className="text-sm">{greeting()}</Text>
          <Text weight="bold" className="text-[22px]">
            {firstName}
          </Text>
        </View>

        {me.data?.account.status === 'disabled' ? (
          <Pressable
            onPress={() => router.navigate('/profile')}
            className="mb-4 flex-row items-center gap-3 rounded-2xl bg-background-notice-subtle px-4 py-3">
            <Icon name="user-forbid-line" size={18} className="text-content-notice" />
            <Text className="flex-1 text-xs leading-5">Your account is disabled. Nobody can send you money.</Text>
            <Text weight="medium" className="text-xs text-content-notice">
              Turn on
            </Text>
          </Pressable>
        ) : null}

        {setup !== 'ready' ? (
          <View className="mb-4 flex-row items-center gap-3 rounded-2xl bg-background-selected px-4 py-3">
            <Icon name={typeof setup === 'object' ? 'error-warning-line' : 'loader-4-line'} size={18} className="text-primary" />
            <Text className="flex-1 text-xs leading-5">
              {typeof setup === 'object'
                ? `Still setting up your wallet: ${setup.error} Retrying…`
                : 'Setting up your wallet with Pollar. Your welcome money arrives in a moment.'}
            </Text>
          </View>
        ) : null}

        <View className="flex-row gap-2.5">
          <BalanceCard
            label="Available Naira"
            amount={nairaShort(ngn)}
            exact={naira(ngn)}
            footnote={rate.data ? `≈ ${usd(ngn / rate.data)}` : ' '}
            hidden={hidden}
            onToggleHidden={toggleHidden}
          />
          <BalanceCard
            label="Available USDC"
            amount={usdShort(usdc)}
            exact={usd(usdc)}
            footnote={rate.data ? `≈ ${nairaShort(usdc * rate.data)}` : ' '}
            hidden={hidden}
            onToggleHidden={toggleHidden}
          />
        </View>

        <View className="mt-5 flex-row gap-2.5">
          {QUICK_ACTIONS.map(({ label, icon, href }) => (
            <Pressable
              key={label}
              onPress={() => router.push(href)}
              className="flex-1 items-center rounded-2xl bg-primary-900 py-4 active:bg-primary-800">
              <View className="h-11 w-11 items-center justify-center rounded-full bg-primary-800">
                <Icon name={icon} size={18} className="text-primary" />
              </View>
              <Text className="mt-3 text-[10px]">{label}</Text>
            </Pressable>
          ))}
        </View>

        <View className="mt-4 flex-row items-center rounded-2xl bg-primary-700 px-4 py-3.5">
          <View className="flex-1">
            <Text weight="medium" className="text-base">
              Tap-to-Pay Mode
            </Text>
            <Text className="mt-0.5 text-xs text-content-link-hover">Use your phone like a contactless card</Text>
          </View>
          <Toggle
            value={tapToPay}
            onValueChange={setTapToPay}
            color={colors.content.positive}
            accessibilityLabel="Tap-to-Pay Mode"
          />
        </View>

        <View className="mt-7 flex-row items-center justify-between">
          <Text weight="bold" className="text-lg">
            Merchant Mode
          </Text>
          <Pressable
            onPress={() => router.push('/merchant')}
            className="rounded-full border border-border-brand bg-background-selected px-3 py-2">
            <Text className="text-[10px]">Switch to Merchant</Text>
          </Pressable>
        </View>

        <View className="mb-3 mt-6 flex-row items-center justify-between px-1">
          <Text weight="medium" className="text-sm">
            Recents
          </Text>
          <Pressable onPress={() => router.navigate({ pathname: '/activity', params: { tab: 'transactions' } })}>
            <Text weight="medium" className="text-sm text-primary underline">
              See all
            </Text>
          </Pressable>
        </View>

        <ListCard>
          {recents
            ? recents.map((entry) => <TransactionRow key={entry.id} entry={entry} />)
            : [0, 1, 2].map((i) => <TransactionRowSkeleton key={i} />)}
        </ListCard>
        {recents?.length === 0 ? (
          <Text className="mt-3 text-center text-xs text-content-tertiary">No transactions yet</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
