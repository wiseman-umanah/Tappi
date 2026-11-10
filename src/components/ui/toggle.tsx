import { Switch } from 'react-native';

import colors from '@/theme/colors';

type ToggleProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Track color when on. Home uses positive green, Cards uses brand blue. */
  color?: string;
  accessibilityLabel?: string;
};

export function Toggle({ value, onValueChange, color = colors.primary.DEFAULT, accessibilityLabel }: ToggleProps) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      accessibilityLabel={accessibilityLabel}
      trackColor={{ false: colors.surface[5], true: color }}
      thumbColor={colors.white}
      ios_backgroundColor={colors.surface[5]}
    />
  );
}
