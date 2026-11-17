import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Icon, type IconName } from '@/components/icon';
import { Text } from '@/components/text';
import type { TapOutcome } from '@/lib/feedback';
import colors from '@/theme/colors';

const VARIANTS: Record<TapOutcome, { icon: IconName; color: string; title: string }> = {
  success: { icon: 'check-line', color: colors.content.positive, title: 'Payment successful' },
  declined: { icon: 'close-line', color: colors.content.negative, title: 'Payment declined' },
  timeout: { icon: 'time-line', color: colors.content.notice, title: 'Tap timed out' },
};

type TapResultProps = {
  outcome: TapOutcome;
  /** Overrides the default title, e.g. "Money added". */
  title?: string;
  /** Optional line under the title, e.g. amount or decline reason. */
  detail?: string;
  size?: number;
};

/** Animated outcome badge: halo pops in, icon springs, declined shakes. */
export function TapResult({ outcome, title: titleOverride, detail, size = 120 }: TapResultProps) {
  const { icon, color, title: defaultTitle } = VARIANTS[outcome];
  const title = titleOverride ?? defaultTitle;
  const halo = useSharedValue(0);
  const mark = useSharedValue(0);
  const shake = useSharedValue(0);

  useEffect(() => {
    halo.value = 0;
    mark.value = 0;
    shake.value = 0;
    halo.value = withSpring(1, { damping: 12, stiffness: 140 });
    mark.value = withDelay(120, withSpring(1, { damping: 9, stiffness: 180 }));
    if (outcome === 'declined') {
      shake.value = withDelay(
        250,
        withSequence(
          ...[-10, 10, -8, 8, -4, 0].map((x) => withTiming(x, { duration: 55 })),
        ),
      );
    }
  }, [outcome, halo, mark, shake]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: halo.value,
    transform: [{ scale: halo.value }, { translateX: shake.value }],
  }));
  const markStyle = useAnimatedStyle(() => ({
    transform: [{ scale: mark.value }],
  }));

  return (
    <View className="items-center">
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: `${color}26`,
            alignItems: 'center',
            justifyContent: 'center',
          },
          haloStyle,
        ]}>
        <Animated.View
          style={[
            {
              width: size * 0.62,
              height: size * 0.62,
              borderRadius: size,
              backgroundColor: color,
              alignItems: 'center',
              justifyContent: 'center',
            },
            markStyle,
          ]}>
          <Icon name={icon} size={size * 0.36} color={colors.white} />
        </Animated.View>
      </Animated.View>
      <Text weight="bold" className="mt-6 text-lg">
        {title}
      </Text>
      {detail ? <Text className="mt-1 text-xs text-content-tertiary">{detail}</Text> : null}
    </View>
  );
}
