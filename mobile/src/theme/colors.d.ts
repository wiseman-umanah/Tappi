type Scale<K extends string> = Record<K, string> & { DEFAULT: string };

declare const colors: {
  white: string;
  black: string;
  transparent: string;
  content: Scale<
    | 'secondary'
    | 'tertiary'
    | 'primary-inverse'
    | 'secondary-inverse'
    | 'tertiary-inverse'
    | 'disabled'
    | 'brand'
    | 'link'
    | 'link-hover'
    | 'link-pressed'
    | 'info'
    | 'info-bold'
    | 'notice'
    | 'notice-bold'
    | 'negative'
    | 'negative-bold'
    | 'positive'
    | 'positive-bold'
  >;
  background: Scale<
    | 'hover'
    | 'pressed'
    | 'selected'
    | 'disabled'
    | 'inverse'
    | 'brand'
    | 'brand-hover'
    | 'brand-pressed'
    | 'info'
    | 'info-subtle'
    | 'notice'
    | 'notice-subtle'
    | 'negative'
    | 'negative-subtle'
    | 'positive'
    | 'positive-subtle'
  >;
  border: Scale<
    | 'secondary'
    | 'tertiary'
    | 'disabled'
    | 'brand'
    | 'inverse'
    | 'focus'
    | 'info'
    | 'notice'
    | 'negative'
    | 'positive'
    | 'mono'
  >;
  surface: Record<0 | 1 | 2 | 3 | 4 | 5 | 6, string>;
  overlay: Scale<'inverse'>;
  primary: Scale<'600' | '700' | '800' | '900'>;
  usdc: string;
  track: string;
  card: string;
};
export = colors;
