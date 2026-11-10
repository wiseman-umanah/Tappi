import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/cn';

const weights = {
  light: 'font-sans-light',
  regular: 'font-sans',
  medium: 'font-sans-medium',
  bold: 'font-sans-bold',
  extrabold: 'font-sans-extrabold',
} as const;

export type TextProps = RNTextProps & {
  className?: string;
  /** Picks the Creato Display file. Use this instead of font-* classes. */
  weight?: keyof typeof weights;
};

/** App text: Creato Display, white by default. Override color/size with className. */
export function Text({ className, weight = 'regular', ...rest }: TextProps) {
  return <RNText className={cn('text-base text-white', weights[weight], className)} {...rest} />;
}
