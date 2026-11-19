import { Pressable, View } from 'react-native';

import { Text } from '@/components/text';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import type { CryptoAsset, CryptoNetwork } from '@/lib/api-types';
import { cn } from '@/lib/cn';

export const COINS = [
  { key: 'USDT', label: 'USDT' },
  { key: 'USDC', label: 'USDC' },
  { key: 'BTC', label: 'Bitcoin' },
] as const;

/** Coin tabs, then the networks that coin can travel on (a wrong network loses the money). */
export function CryptoPicker({
  asset,
  onAsset,
  networks,
  chain,
  onChain,
}: {
  asset: CryptoAsset;
  onAsset: (asset: CryptoAsset) => void;
  networks: CryptoNetwork[];
  chain: string | null;
  onChain: (chain: string) => void;
}) {
  return (
    <View>
      <SegmentedTabs tabs={COINS} value={asset} onChange={onAsset} className="mt-6" />
      <Text className="mb-2 mt-6 text-xs text-content-tertiary">Network</Text>
      <View className="flex-row flex-wrap gap-2">
        {networks.map((n) => {
          const selected = n.chain === chain;
          return (
            <Pressable
              key={n.chain}
              onPress={() => onChain(n.chain)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              className={cn('rounded-full border px-3.5 py-2', selected ? 'border-primary bg-primary-900' : 'border-border-tertiary bg-surface-2')}>
              <Text className="text-xs">{n.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
