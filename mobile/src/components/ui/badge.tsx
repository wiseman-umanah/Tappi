import { View } from 'react-native';

import { Text } from '@/components/text';
import { cn } from '@/lib/cn';

const TONES = {
  positive: { box: 'bg-background-positive-subtle', text: 'text-content-positive' },
  positiveOutline: { box: 'border border-border-positive', text: 'text-content-positive' },
  negativeOutline: { box: 'border border-border-negative', text: 'text-content-negative' },
  noticeOutline: { box: 'border border-border-notice', text: 'text-content-notice' },
  neutral: { box: 'bg-surface-3', text: 'text-content-tertiary' },
} as const;

type BadgeProps = { label: string; tone?: keyof typeof TONES; className?: string };

export function Badge({ label, tone = 'neutral', className }: BadgeProps) {
  const t = TONES[tone];
  return (
    <View className={cn('self-start rounded-full px-2 py-0.5', t.box, className)}>
      <Text className={cn('text-[9px]', t.text)}>{label}</Text>
    </View>
  );
}
