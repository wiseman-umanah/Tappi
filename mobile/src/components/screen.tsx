import type { ReactElement, ReactNode } from 'react';
import { ScrollView, View, type RefreshControlProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TAB_BAR_CLEARANCE, tabBarOffset } from '@/components/tab-bar';
import { Text } from '@/components/text';
import { cn } from '@/lib/cn';

type ScreenProps = {
  title?: string;
  subtitle?: string;
  /** Element on the right of the title, e.g. "Switch to Customer". */
  headerRight?: ReactNode;
  /** Leave room for the floating tab bar (tab screens only). */
  withTabBar?: boolean;
  scroll?: boolean;
  /** Pull-to-refresh, e.g. `<RefreshControl … />`. */
  refreshControl?: ReactElement<RefreshControlProps>;
  className?: string;
  children?: ReactNode;
};

/** Page shell matching the designs: dark background, 20px gutters, title + subtitle header. */
export function Screen({
  title,
  subtitle,
  headerRight,
  withTabBar = false,
  scroll = true,
  refreshControl,
  className,
  children,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const paddingBottom = withTabBar ? TAB_BAR_CLEARANCE + tabBarOffset(insets.bottom) : 24 + insets.bottom;

  const header = title ? (
    <View className="mb-6 mt-4 flex-row items-center justify-between">
      <View className="flex-1">
        <Text weight="bold" className="text-[22px]">
          {title}
        </Text>
        {subtitle ? <Text className="mt-0.5 text-xs text-content-tertiary">{subtitle}</Text> : null}
      </View>
      {headerRight}
    </View>
  ) : null;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {scroll ? (
        <ScrollView
          contentContainerClassName={cn('px-5', className)}
          contentContainerStyle={{ paddingBottom }}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}>
          {header}
          {children}
        </ScrollView>
      ) : (
        <View className={cn('flex-1 px-5', className)} style={{ paddingBottom }}>
          {header}
          {children}
        </View>
      )}
    </View>
  );
}
