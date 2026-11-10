import { View } from 'react-native';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import type { Entry } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { signedMoney, when } from '@/lib/format';
import { CHANNEL_LABEL, tagIcon } from '@/lib/tags';

/** Row used in Recents (home) and Activity → Transactions. */
export function TransactionRow({ entry }: { entry: Entry }) {
  const isRefund = entry.kind === 'refund_in' || entry.kind === 'refund_out';
  const meta = [
    isRefund ? 'Refund' : entry.tag,
    when(entry.at),
    entry.channel && entry.channel !== 'send' ? CHANNEL_LABEL[entry.channel] : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <View className="h-7 w-7 items-center justify-center rounded-md bg-primary-600">
        <Icon name={isRefund ? 'refund-2-line' : tagIcon(entry.tag)} size={14} />
      </View>
      <View className="flex-1">
        <Text weight="medium" className="text-sm" numberOfLines={1}>
          {entry.title}
        </Text>
        <Text className="mt-0.5 text-[10px] text-content-tertiary" numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {entry.kind === 'swap' && entry.assetIn ? (
        <View className="items-end">
          <Text weight="bold" className={cn('text-[13px]', entry.assetIn === 'USDC' && 'text-usdc')}>
            {signedMoney(entry.amountIn ?? 0, entry.assetIn)}
          </Text>
          <Text className="text-[10px] text-content-tertiary">{signedMoney(entry.amount, entry.asset)}</Text>
        </View>
      ) : (
        <Text
          weight="bold"
          className={cn('text-[15px]', entry.asset === 'USDC' && 'text-usdc', entry.amount > 0 && entry.asset === 'NGN' && 'text-content-positive')}>
          {signedMoney(entry.amount, entry.asset)}
        </Text>
      )}
    </View>
  );
}

/** Placeholder rows while data loads. */
export function TransactionRowSkeleton() {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-7 w-7 rounded-md bg-surface-4" />
      <View className="flex-1 gap-1.5">
        <View className="h-3 w-32 rounded bg-surface-4" />
        <View className="h-2 w-20 rounded bg-surface-3" />
      </View>
      <View className="h-3 w-16 rounded bg-surface-4" />
    </View>
  );
}
