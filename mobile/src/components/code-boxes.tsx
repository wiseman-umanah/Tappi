import { useEffect, useRef, type ComponentRef } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/text';
import colors from '@/theme/colors';

type CodeBoxesProps = {
  length: number;
  value: string;
  onChangeText?: (value: string) => void;
  /** Dots instead of digits (PINs). */
  secure?: boolean;
  autoFocus?: boolean;
  editable?: boolean;
  /** Shake and turn red, e.g. after a wrong PIN. Change the number to replay it. */
  errorKey?: number;
  accessibilityLabel: string;
};

function Box({ char, active, secure, width }: { char?: string; active: boolean; secure?: boolean; width: number }) {
  const pop = useSharedValue(char ? 1 : 0);
  const flash = useSharedValue(0);

  // Each digit pops in and briefly glows blue as it lands.
  useEffect(() => {
    if (char) {
      pop.value = 0.4;
      pop.value = withSpring(1, { damping: 9, stiffness: 260 });
      flash.value = withSequence(withTiming(1, { duration: 90 }), withTiming(0, { duration: 420 }));
    } else {
      pop.value = 0;
    }
  }, [char, pop, flash]);

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(flash.value, [0, 1], [colors.surface[1], colors.primary[800]]),
    borderColor: active ? colors.primary.DEFAULT : flash.value > 0.05 ? colors.primary.DEFAULT : colors.border.secondary,
  }));
  const charStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }], opacity: Math.min(1, pop.value * 1.5) }));

  return (
    <Animated.View
      style={[{ width, height: width * 1.08, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' }, boxStyle]}>
      <Animated.View style={charStyle}>
        {char ? (
          secure ? (
            <View className="h-3.5 w-3.5 rounded-full bg-white" />
          ) : (
            <Text weight="bold" className="text-2xl">
              {char}
            </Text>
          )
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

/** Row of digit boxes over a hidden input. Used for login codes and PINs. */
export function CodeBoxes({ length, value, onChangeText, secure, autoFocus, editable = true, errorKey, accessibilityLabel }: CodeBoxesProps) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const shake = useSharedValue(0);

  useEffect(() => {
    if (!errorKey) return;
    shake.value = withSequence(...[-12, 12, -9, 9, -4, 0].map((x) => withTiming(x, { duration: 50 })));
  }, [errorKey, shake]);

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const width = length > 4 ? 48 : 64;

  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityLabel={accessibilityLabel}>
      <Animated.View style={[{ flexDirection: 'row', gap: length > 4 ? 8 : 12 }, rowStyle]}>
        {Array.from({ length }, (_, i) => (
          <Box key={i} char={value[i]} active={editable && i === value.length} secure={secure} width={width} />
        ))}
      </Animated.View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={(text) => onChangeText?.(text.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus={autoFocus}
        editable={editable}
        secureTextEntry={secure}
        caretHidden
        textContentType={secure ? 'none' : 'oneTimeCode'}
        autoComplete={secure ? 'off' : 'one-time-code'}
        className="absolute h-px w-px opacity-0"
        accessibilityLabel={accessibilityLabel}
      />
    </Pressable>
  );
}
