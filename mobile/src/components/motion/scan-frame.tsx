import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import colors from '@/theme/colors';

type ScanFrameProps = {
  size?: number;
  color?: string;
  /** Breathe the corners in and out while waiting for a tap. */
  active?: boolean;
  children?: ReactNode;
};

const ARM = 40;
const THICKNESS = 8;

/** Corner-bracket frame from the NFC tap screen (design/screens/10-nfc-tap-to-pay.png). */
export function ScanFrame({ size = 284, color = colors.primary.DEFAULT, active = true, children }: ScanFrameProps) {
  const inset = useSharedValue(0);

  useEffect(() => {
    inset.value = active
      ? withRepeat(withTiming(10, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, true)
      : withTiming(0);
  }, [active, inset]);

  const corner = (position: ViewStyle, sides: ViewStyle) => (
    <View style={[styles.corner, position, sides, { borderColor: color }]} />
  );

  const animated = useAnimatedStyle(() => ({
    top: inset.value,
    left: inset.value,
    right: inset.value,
    bottom: inset.value,
  }));

  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Animated.View style={[styles.corners, animated]} pointerEvents="none">
        {corner({ top: 0, left: 0 }, { borderTopWidth: THICKNESS, borderLeftWidth: THICKNESS })}
        {corner({ top: 0, right: 0 }, { borderTopWidth: THICKNESS, borderRightWidth: THICKNESS })}
        {corner({ bottom: 0, left: 0 }, { borderBottomWidth: THICKNESS, borderLeftWidth: THICKNESS })}
        {corner({ bottom: 0, right: 0 }, { borderBottomWidth: THICKNESS, borderRightWidth: THICKNESS })}
      </Animated.View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  corners: { position: 'absolute' },
  corner: { position: 'absolute', width: ARM, height: ARM },
});
