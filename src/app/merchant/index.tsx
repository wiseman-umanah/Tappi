import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { Badge } from '@/components/ui/badge';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import { api } from '@/lib/api';
import type { Asset, Dashboard, MerchantPayment, PaymentRequest } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { money, naira, nairaShort, usd, when } from '@/lib/format';
import { useMerchant } from '@/lib/queries';
import { CHANNEL_LABEL, CHARGE_TAGS, tagIcon } from '@/lib/tags';
import colors from '@/theme/colors';

// Designs: design/screens/12-merchant-terminal.png, 13-merchant-transactions.png,
// 14-merchant-analytics.png
const TABS = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'transactions', label: 'Transaction' },
  { key: 'analytics', label: 'Analytics' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

// ---------------- Terminal ----------------

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'] as const;
const MAX_DIGITS = 10; // up to ₦99,999,999.99

const CURRENCIES: { asset: Asset; label: string }[] = [
  { asset: 'NGN', label: 'NGN ₦' },
  { asset: 'USDC', label: 'USDC $' },
];

function Terminal() {
  // POS-style entry: digits are kobo (or cents), so typing 5 0 0 0 0 0 reads ₦5,000.00.
  const [digits, setDigits] = useState('');
  const [asset, setAsset] = useState<Asset>('NGN');
  const [tag, setTag] = useState<(typeof CHARGE_TAGS)[number]>('Groceries');
  const amount = Number(digits || '0') / 100;
  const shown = asset === 'USDC' ? usd(amount) : naira(amount);

  const create = useMutation({
    mutationFn: () => api<PaymentRequest>('/requests', { body: { amount, asset, tag } }),
    onSuccess: (request) => {
      setDigits('');
      router.push({ pathname: '/charge/[id]', params: { id: request.id } });
    },
  });

  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'back') return setDigits((d) => d.slice(0, -1));
    setDigits((d) => (d === '' && key.startsWith('0') ? d : (d + key).slice(0, MAX_DIGITS)));
  };

  const charge = () => {
    if (amount > 0 && !create.isPending) create.mutate();
  };

  return (
    <View className="mt-5 rounded-2xl border border-border-disabled bg-surface-3 p-5">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs uppercase">New charge</Text>
        {/* Charge in naira or USDC; the customer can pay from either balance. */}
        <View className="flex-row gap-1" accessibilityRole="radiogroup" accessibilityLabel="Currency">
          {CURRENCIES.map((c) => (
            <Pressable
              key={c.asset}
              onPress={() => setAsset(c.asset)}
              accessibilityRole="radio"
              accessibilityState={{ selected: asset === c.asset }}
              hitSlop={4}
              className={cn('rounded border px-2 py-0.5', asset === c.asset ? 'border-white bg-black' : 'border-border-disabled')}>
              <Text weight="medium" className={cn('text-xs', asset !== c.asset && 'text-content-tertiary')}>
                {c.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Text
        weight="bold"
        numberOfLines={1}
        adjustsFontSizeToFit
        className={cn('mt-6 text-center text-[40px]', amount > 0 ? 'text-white' : 'text-content-tertiary')}>
        {shown}
      </Text>
      <Pressable onPress={() => setDigits('')} hitSlop={8} className="mb-5 mt-1 self-center">
        <Text className="text-xs text-content-tertiary">Clear</Text>
      </Pressable>

      <View className="mb-5 flex-row gap-2">
        {CHARGE_TAGS.map((t) => (
          <Pressable
            key={t}
            onPress={() => setTag(t)}
            accessibilityRole="radio"
            accessibilityState={{ selected: tag === t }}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-1 rounded-full border py-1.5',
              tag === t ? 'border-primary bg-background-selected' : 'border-border-disabled',
            )}>
            <Icon name={tagIcon(t)} size={11} className={tag === t ? 'text-primary' : 'text-content-tertiary'} />
            <Text className={cn('text-[10px]', tag === t ? 'text-white' : 'text-content-tertiary')}>{t}</Text>
          </Pressable>
        ))}
      </View>

      <View className="flex-row flex-wrap justify-between gap-y-3">
        {KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => press(key)}
            accessibilityLabel={key === 'back' ? 'Delete' : key}
            className="h-16 w-[30%] items-center justify-center rounded-lg border border-border-disabled bg-surface-1 active:bg-background-hover">
            {key === 'back' ? (
              <Icon name="delete-back-2-line" size={22} />
            ) : (
              <Text weight="medium" className="text-lg">
                {key}
              </Text>
            )}
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={charge}
        disabled={amount <= 0 || create.isPending}
        className={cn('mt-5 items-center rounded-full bg-primary py-3.5', amount <= 0 && 'opacity-50')}>
        {create.isPending ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text weight="bold" className="text-lg">
            {amount > 0 ? `Charge ${shown}` : 'Charge'}
          </Text>
        )}
      </Pressable>
      {create.isError ? <Text className="mt-2 text-center text-xs text-content-negative">{create.error.message}</Text> : null}
    </View>
  );
}

// ---------------- Transactions ----------------

const FILTERS = ['All', 'Completed', 'Refunded', 'Failed'] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_TONE: Record<MerchantPayment['status'], 'positiveOutline' | 'noticeOutline' | 'negativeOutline'> = {
  Completed: 'positiveOutline',
  Refunded: 'noticeOutline',
  Failed: 'negativeOutline',
};

function Transactions({ payments }: { payments: Dashboard['payments'] }) {
  const [filter, setFilter] = useState<Filter>('All');
  const rows = filter === 'All' ? payments : payments.filter((p) => p.status === filter);

  const refund = (p: MerchantPayment) =>
    router.push({ pathname: '/approve', params: { action: 'refund', id: p.id, amount: String(p.amount), asset: p.asset, name: p.payer } });

  return (
    <View className="mt-6">
      <Text weight="bold" className="text-lg">
        Transactions
      </Text>
      <Text className="text-xs text-content-tertiary">
        {payments.length} {payments.length === 1 ? 'payment' : 'payments'}
      </Text>

      <View className="mb-5 mt-4 flex-row border-b border-border-tertiary">
        {FILTERS.map((f) => {
          const active = f === filter;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              className={cn('mr-6 pb-2', active && 'border-b-2 border-primary')}>
              <Text weight="medium" className={cn('text-sm', active ? 'text-primary' : 'text-content-tertiary')}>
                {f}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View className="gap-2.5">
        {rows.map((p) => (
          <View
            key={p.id}
            className="flex-row items-center gap-3 rounded-xl border border-border-disabled bg-surface-3 px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-md bg-surface-1">
              <Icon name={tagIcon(p.tag)} size={18} className="text-content-tertiary" />
            </View>
            <View className="flex-1">
              <Text weight="medium" className="text-sm" numberOfLines={1}>
                {p.payer}
              </Text>
              <Text className="mt-0.5 text-[10px] text-content-tertiary" numberOfLines={1}>
                {[p.tag, when(p.at), p.channel ? CHANNEL_LABEL[p.channel] : null].filter(Boolean).join(' · ')}
              </Text>
              {p.status === 'Completed' ? (
                <Text weight="medium" className="mt-1 text-[10px] text-primary" onPress={() => refund(p)} accessibilityRole="button">
                  Refund
                </Text>
              ) : null}
            </View>
            <View className="items-end gap-1">
              <Text weight="bold" className={cn('text-[15px]', p.status !== 'Completed' && 'text-content-tertiary')}>
                {money(p.amount, p.asset)}
              </Text>
              <Badge label={p.status} tone={STATUS_TONE[p.status]} />
            </View>
          </View>
        ))}
        {rows.length === 0 ? (
          <Text className="py-10 text-center text-sm text-content-tertiary">
            {filter === 'All' ? 'Charges you take in the Terminal show up here.' : `No ${filter.toLowerCase()} payments`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------- Analytics ----------------

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View className="flex-1 rounded-lg bg-primary-900 p-3">
      <Icon name="bar-chart-2-line" size={12} className="text-primary" />
      <Text className="mt-3 text-[10px] text-content-secondary">{label}</Text>
      <Text weight="bold" className="mt-1 text-[13px]" numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text className="mt-2 text-[9px] text-content-tertiary">{sub}</Text>
    </View>
  );
}

const CHART_H = 110;

function WeeklyChart({ weekly }: { weekly: Dashboard['weekly'] }) {
  const total = weekly.reduce((s, d) => s + d.amount, 0);
  const peak = Math.max(1, ...weekly.map((d) => d.amount));

  return (
    <View className="mt-5 rounded-xl bg-primary-800 p-4">
      <View className="flex-row items-start justify-between">
        <View>
          <Text weight="medium" className="text-base">
            Weekly terminal revenue
          </Text>
          <Text className="text-[9px]">Last 7 days</Text>
        </View>
        <Text weight="bold" className="text-base text-primary">
          {nairaShort(total)}
        </Text>
      </View>

      <View className="mt-10" style={{ height: CHART_H }}>
        {/* Peak marker */}
        <Svg height={2} width="100%" style={{ position: 'absolute', top: 0 }}>
          <Line x1="0" y1="1" x2="100%" y2="1" stroke={colors.content.tertiary} strokeWidth={1.5} strokeDasharray="6 5" />
        </Svg>
        <View className="flex-1 flex-row items-end justify-between px-1">
          {weekly.map((d, i) => {
            const isToday = i === weekly.length - 1;
            return (
              <View
                key={d.day}
                className={cn('w-[11%] rounded-lg', isToday ? 'bg-primary' : 'bg-primary-700')}
                style={{ height: Math.max(6, (d.amount / peak) * (CHART_H - 6)) }}
              />
            );
          })}
        </View>
      </View>
      <View className="h-0.5 rounded-full bg-content-brand" />
      <View className="mt-2 flex-row justify-between px-1">
        {weekly.map((d) => (
          <Text key={d.day} className="w-[11%] text-center text-[9px] text-content-brand">
            {d.day}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Analytics({ data: a }: { data: Dashboard }) {
  const settle = () =>
    router.push({ pathname: '/approve', params: { action: 'settle', amount: String(a.payoutBalance) } });
  const nothing = a.payoutBalance < 1;

  return (
    <View className="mt-5">
      <View className="flex-row gap-2.5">
        <StatTile
          label="Today's Volume"
          value={nairaShort(a.todayVolume)}
          sub={a.todayUsdc > 0 ? `incl. ${usd(a.todayUsdc)} USDC` : 'Gross sales today'}
        />
        <StatTile label="Payments" value={String(a.todayTaps)} sub="Successful today" />
        <StatTile label="Payout Balance" value={nairaShort(a.payoutBalance)} sub="Ready to settle" />
      </View>

      <WeeklyChart weekly={a.weekly} />

      <View className="mt-5 rounded-xl border border-primary bg-primary-900 p-5">
        <Text weight="medium" className="text-base">
          Instant Settlement to Bank
        </Text>
        <Text className="mt-1 text-[10px]">
          {nothing
            ? `Everything is settled to ${a.settlementBank}.`
            : `Move your naira payout balance to ${a.settlementBank} in seconds. (Testnet: simulated payout.)`}
          {' USDC sales stay in your USDC balance.'}
        </Text>
        <Pressable
          onPress={settle}
          disabled={nothing}
          className={cn('mt-4 flex-row items-center gap-1.5 self-start rounded-full bg-primary px-4 py-2.5', nothing && 'bg-background-positive')}>
          {nothing ? <Icon name="check-line" size={14} /> : null}
          <Text weight="medium" className="text-sm">
            {nothing ? 'All settled' : `Settle ${naira(a.payoutBalance)}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------- Screen ----------------

export default function MerchantScreen() {
  const params = useLocalSearchParams<{ tab?: TabKey }>();
  const [tab, setTab] = useState<TabKey>(params.tab ?? 'terminal');
  const toCustomer = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const dashboard = useMerchant();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    await dashboard.refetch().finally(() => setRefreshing(false));
  };
  const data = dashboard.data;

  return (
    <Screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.white} />}
      title="Merchant"
      headerRight={
        <Pressable
          onPress={toCustomer}
          className="rounded-full border border-border-secondary bg-surface-3 px-3 py-2">
          <Text className="text-[10px] text-content-tertiary">Switch to Customer</Text>
        </Pressable>
      }>
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'terminal' ? <Terminal /> : null}
      {tab !== 'terminal' && !data ? (
        dashboard.isError ? (
          <Text className="mt-16 text-center text-sm text-content-tertiary">{dashboard.error.message}</Text>
        ) : (
          <ActivityIndicator className="mt-16" color="#FFFFFF" />
        )
      ) : null}
      {tab === 'transactions' && data ? <Transactions payments={data.payments} /> : null}
      {tab === 'analytics' && data ? <Analytics data={data} /> : null}
    </Screen>
  );
}
