import { router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { Icon, type IconName } from '@/components/icon';
import { TappiLogo } from '@/components/tappi-logo';
import { Text } from '@/components/text';
import { cn } from '@/lib/cn';
import colors from '@/theme/colors';

// Geometry from the design (assets/images/brand/tab-bar.svg), in SVG units.
const BAR_W = 353;
const BAR_H = 77;
const BAR_PATH =
  'M314.5 0C335.763 0 353 17.237 353 38.5C353 59.763 335.763 77 314.5 77H38.5C17.237 77 0 59.763 0 38.5C0 17.237 17.237 0 38.5 0H85.7435C116.387 0 145.856 35 176.5 35C207.144 35 236.613 0 267.257 0H314.5Z';
const FAB = 58;
const PILL = 46;

const TABS: Record<string, { label: string; icon: IconName; x: number }> = {
  index: { label: 'Wallet', icon: 'wallet-3-line', x: 39 },
  activity: { label: 'Activity', icon: 'file-list-3-line', x: 103 },
  cards: { label: 'Cards', icon: 'bank-card-line', x: 249 },
  profile: { label: 'Profile', icon: 'user-3-line', x: 313 },
};

/** Gap under the floating bar; it sits partly inside the home-indicator inset. */
export const tabBarOffset = (bottomInset: number) => Math.max(bottomInset - 20, 8);

/** Space screens should leave at the bottom (on top of tabBarOffset) so content clears the bar. */
export const TAB_BAR_CLEARANCE = 112;

export function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const w = Math.min(width - 40, 440);
  const scale = w / BAR_W;
  const h = BAR_H * scale;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { bottom: tabBarOffset(insets.bottom) }]}>
      <View style={{ width: w, height: h }}>
        <Svg width={w} height={h} viewBox={`0 0 ${BAR_W} ${BAR_H}`} style={StyleSheet.absoluteFill}>
          <Path d={BAR_PATH} fill={colors.surface[2]} />
        </Svg>

        {state.routes.map((route, index) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const focused = state.index === index;
          const onPress = () => {
            const event = emitter.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigateToTab(route.key);
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={tab.label}
              className={cn('items-center justify-center rounded-full', focused && 'bg-primary-800')}
              style={{
                position: 'absolute',
                left: tab.x * scale - PILL / 2,
                top: (h - PILL) / 2,
                width: PILL,
                height: PILL,
              }}>
              <Icon name={tab.icon} size={16} className={focused ? 'text-primary' : 'text-white'} />
              <Text className={cn('mt-0.5 text-[8px]', focused ? 'text-primary' : 'text-white')}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => router.push('/assistant')}
          accessibilityRole="button"
          accessibilityLabel="Tappi AI"
          className="items-center justify-center rounded-full bg-primary"
          style={[styles.fab, { left: w / 2 - FAB / 2 }]}>
          <TappiLogo size={26} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  fab: {
    position: 'absolute',
    top: -FAB / 2,
    width: FAB,
    height: FAB,
    boxShadow: `0 0 28px ${colors.primary.DEFAULT}99`,
  },
});
