import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { TappiLogo } from '@/components/tappi-logo';
import colors from '@/theme/colors';

const RINGS = 3;
const DURATION = 2100;

type NfcPulseProps = {
  size?: number;
  color?: string;
  /** Stop the rings, e.g. once a card has been read. */
  active?: boolean;
};

function Ring({ progress, size, color }: { progress: SharedValue<number>; size: number; color: string }) {
  const style = useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * 0.6,
    transform: [{ scale: 0.35 + progress.value * 0.65 }],
  }));
  return (
    <Animated.View
      style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderColor: color }, style]}
    />
  );
}

/** "Listening" animation: rings ripple out from the Tappi mark while NFC is active. */
export function NfcPulse({ size = 200, color = colors.primary.DEFAULT, active = true }: NfcPulseProps) {
  const p0 = useSharedValue(0);
  const p1 = useSharedValue(0);
  const p2 = useSharedValue(0);
  const rings = [p0, p1, p2];

  useEffect(() => {
    [p0, p1, p2].forEach((p, i) => {
      p.value = active
        ? withDelay(
            (DURATION / RINGS) * i,
            withRepeat(withTiming(1, { duration: DURATION, easing: Easing.out(Easing.quad) }), -1, false),
          )
        : withTiming(0, { duration: 200 });
    });
  }, [active, p0, p1, p2]);

  const core = size * 0.32;
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      {rings.map((p, i) => (
        <Ring key={i} progress={p} size={size} color={color} />
      ))}
      <View
        className="items-center justify-center rounded-full bg-primary"
        style={{ width: core, height: core, boxShadow: `0 0 32px ${color}88` }}>
        <TappiLogo size={core * 0.45} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 2 },
});
