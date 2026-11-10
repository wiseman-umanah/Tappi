import { Text, type TextProps } from 'react-native';

import { cn } from '@/lib/cn';

import { glyphs, type IconName } from './glyphs';

export type { IconName };

type IconProps = Omit<TextProps, 'children'> & {
  /** Remix Icon name without the `ri-` prefix, e.g. "wallet-3-line". */
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
};

/** Remix Icon rendered from the bundled icon font. Color via `color` or a text-* class. */
export function Icon({ name, size = 24, color, className, style, ...rest }: IconProps) {
  return (
    <Text
      accessible={false}
      {...rest}
      className={cn('text-white', className)}
      style={[
        { fontFamily: 'remixicon', fontSize: size, lineHeight: size, includeFontPadding: false },
        color ? { color } : null,
        style,
      ]}>
      {String.fromCodePoint(glyphs[name])}
    </Text>
  );
}
