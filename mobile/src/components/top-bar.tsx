import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';

/** Back (or close) button with an optional centred title, for stack and modal screens. */
export function TopBar({ title, close = false, onBack }: { title?: string; close?: boolean; onBack?: () => void }) {
  return (
    <View className="mt-2 h-11 flex-row items-center">
      <Pressable
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
        accessibilityRole="button"
        accessibilityLabel={close ? 'Close' : 'Back'}
        hitSlop={8}
        className="h-10 w-10 items-center justify-center rounded-full bg-surface-2">
        <Icon name={close ? 'close-line' : 'arrow-left-line'} size={20} />
      </Pressable>
      {title ? (
        <Text weight="bold" className="flex-1 pr-10 text-center text-base">
          {title}
        </Text>
      ) : null}
    </View>
  );
}
