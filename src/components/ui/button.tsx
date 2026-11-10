import { ActivityIndicator, Pressable, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Text } from '@/components/text';
import { cn } from '@/lib/cn';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
};

export function Button({ label, onPress, variant = 'primary', icon, loading, disabled, className }: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      className={cn(
        'h-[52px] flex-row items-center justify-center gap-2 rounded-full px-6',
        variant === 'primary' && 'bg-primary active:bg-primary-600',
        variant === 'secondary' && 'border border-border-secondary bg-surface-2 active:bg-surface-3',
        variant === 'ghost' && 'h-11',
        variant === 'danger' && 'bg-background-negative active:opacity-80',
        disabled && !loading && 'opacity-50',
        className,
      )}>
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <View className="flex-row items-center gap-2">
          {icon ? <Icon name={icon} size={18} className={variant === 'ghost' ? 'text-primary' : undefined} /> : null}
          <Text weight={variant === 'ghost' ? 'medium' : 'bold'} className={cn('text-base', variant === 'ghost' && 'text-sm text-primary')}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
