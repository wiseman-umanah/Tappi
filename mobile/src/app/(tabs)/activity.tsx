import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { ListCard } from '@/components/ui/list-card';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import { TransactionRow } from '@/components/ui/transaction-row';
import type { Activity, Entry } from '@/lib/api-types';
import { naira, nairaShort } from '@/lib/format';
import { useActivity } from '@/lib/queries';
import colors from '@/theme/colors';

// Designs: design/screens/03-activity-total-spent.png, 05-activity-conversion-insight.png,
// 06-activity-transactions.png, 08-activity-empty.png
const TABS = [
  { key: 'spent', label: 'Total Spent' },
  { key: 'conversion', label: 'Conversion insight' },
  { key: 'transactions', label: 'Transactions' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function Empty({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View className="mt-20 items-center px-8">
      <Icon name={icon} size={28} className="text-content-disabled" />
      <Text className="mt-3 text-center text-sm text-content-tertiary">{text}</Text>
    </View>
  );
}

function TotalSpent({ spending }: { spending: Activity['spending'] }) {
  if (spending.tags.length === 0) return <Empty icon="pie-chart-line" text="Payments you make this month show up here, by tag." />;
  // Largest tag fills ~65% so every bar keeps some visible track, as in the design.
  const max = Math.max(...spending.tags.map((t) => t.percent)) / 0.65;
  return (
    <View>
      <View className="mb-10 mt-8 items-center">
        <Text weight="bold" className="text-[32px]">
          {nairaShort(spending.total)}
        </Text>
        <Text className="mt-1 text-xs text-content-disabled">
          {spending.payments} {spending.payments === 1 ? 'payment' : 'payments'}
        </Text>
      </View>
      <View className="gap-6">
        {spending.tags.map(({ tag, amount, percent }) => (
          <View key={tag}>
            <View className="mb-2 flex-row items-center justify-between">
              <Text weight="medium" className="text-sm">
                {tag}
              </Text>
              <Text className="text-xs">
                <Text weight="bold" className="text-xs">
                  {naira(amount, 0)}
                </Text>
                <Text className="text-xs text-content-tertiary">{`   ${percent}%`}</Text>
              </Text>
            </View>
            <View className="h-1 flex-row gap-1">
              <View className="rounded-full bg-primary-600" style={{ flex: percent / max }} />
              <View className="rounded-full bg-track" style={{ flex: 1 - percent / max }} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The user's swaps: what went out and what came in (each row shows both). */
function ConversionInsight({ entries }: { entries: Entry[] }) {
  const swaps = entries.filter((e) => e.kind === 'swap');
  return (
    <View className="mt-6">
      {swaps.length ? (
        <ListCard>
          {swaps.map((entry) => (
            <TransactionRow key={entry.id} entry={entry} />
          ))}
        </ListCard>
      ) : (
        <Empty icon="exchange-line" text="No swaps yet. Swap between naira, USDT, USDC and Bitcoin from the Wallet tab." />
      )}
    </View>
  );
}

export default function ActivityScreen() {
  const params = useLocalSearchParams<{ tab?: TabKey }>();
  const [tab, setTab] = useState<TabKey>(params.tab ?? 'spent');
  const activity = useActivity();

  // "See all" on the home screen deep-links to a tab.
  const [linkedTab, setLinkedTab] = useState(params.tab);
  if (params.tab !== linkedTab) {
    setLinkedTab(params.tab);
    if (params.tab) setTab(params.tab);
  }

  const data = activity.data;
  return (
    <Screen
      title="Activity"
      subtitle="Spending this month, by tag"
      withTabBar
      refreshControl={
        <RefreshControl refreshing={activity.isRefetching} onRefresh={() => void activity.refetch()} tintColor={colors.white} />
      }>
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      {!data ? (
        activity.isError ? (
          <Empty icon="wifi-off-line" text={activity.error.message} />
        ) : (
          <ActivityIndicator className="mt-20" color="#FFFFFF" />
        )
      ) : (
        <>
          {tab === 'spent' ? <TotalSpent spending={data.spending} /> : null}
          {tab === 'conversion' ? <ConversionInsight entries={data.entries} /> : null}
          {tab === 'transactions' ? (
            data.entries.length ? (
              <ListCard className="mt-5">
                {data.entries.map((entry) => (
                  <TransactionRow key={entry.id} entry={entry} />
                ))}
              </ListCard>
            ) : (
              <Empty icon="file-list-3-line" text="No transactions yet." />
            )
          ) : null}
        </>
      )}
    </Screen>
  );
}
