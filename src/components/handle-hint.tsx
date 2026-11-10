import { Pressable, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Text } from '@/components/text';
import { cn } from '@/lib/cn';
import type { HandleState } from '@/lib/queries';

const LOOK: Partial<Record<HandleState['state'], { icon: IconName; tone: string }>> = {
  checking: { icon: 'loader-4-line', tone: 'text-content-tertiary' },
  available: { icon: 'checkbox-circle-fill', tone: 'text-content-positive' },
  taken: { icon: 'close-circle-fill', tone: 'text-content-negative' },
  invalid: { icon: 'error-warning-line', tone: 'text-content-tertiary' },
  error: { icon: 'error-warning-line', tone: 'text-content-negative' },
};

/** Sits under a username field: availability as you type, and free alternatives when it's taken. */
export function HandleHint({ check, onPick }: { check: HandleState; onPick: (handle: string) => void }) {
  const look = LOOK[check.state];
  if (!look) return null;
  const message = 'message' in check ? check.message : 'Checking…';
  return (
    <View className="mt-2 px-1" accessibilityLiveRegion="polite">
      <View className="flex-row items-center gap-1.5">
        <Icon name={look.icon} size={14} className={look.tone} />
        <Text className={cn('text-xs', look.tone)}>{message}</Text>
      </View>
      {check.state === 'taken' && check.suggestions.length ? (
        <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
          <Text className="text-xs text-content-tertiary">Try</Text>
          {check.suggestions.map((handle) => (
            <Pressable key={handle} onPress={() => onPick(handle)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Use @${handle}`}>
              <Text weight="medium" className="text-xs text-primary">
                @{handle}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
