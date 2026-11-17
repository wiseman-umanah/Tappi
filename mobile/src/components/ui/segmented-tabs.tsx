import { Pressable, View } from 'react-native';

import { Text } from '@/components/text';
import { cn } from '@/lib/cn';

type SegmentedTabsProps<T extends string> = {
  tabs: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
};

/** Pill switcher from Activity and Merchant (design/screens/03, 12). */
export function SegmentedTabs<T extends string>({ tabs, value, onChange, className }: SegmentedTabsProps<T>) {
  return (
    <View
      accessibilityRole="tablist"
      className={cn('flex-row rounded-full border border-border-disabled bg-surface-2 p-1', className)}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={cn('flex-1 items-center rounded-full py-2', active && 'bg-primary')}>
            <Text
              weight="medium"
              numberOfLines={1}
              className={cn('text-xs', active ? 'text-white' : 'text-content-tertiary')}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
