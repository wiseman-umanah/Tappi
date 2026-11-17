// Design tokens. Shared by tailwind.config.js (as classes, e.g. `text-content-tertiary`,
// `bg-background-selected`, `bg-surface-2`) and by TS code that needs raw values.
//
// Source of truth: design/colors.png (semantic tokens, exact hex per row).
// Where the sheet labels one scale step with two different hex values, each token
// keeps the hex shown in its own row.
module.exports = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  content: {
    DEFAULT: '#FFFFFF', // Content Primary
    secondary: '#F5F5F5',
    tertiary: '#A1A1A1',
    'primary-inverse': '#171717',
    'secondary-inverse': '#262626',
    'tertiary-inverse': '#525252',
    disabled: '#4D4D4D',
    brand: '#80AEF9',
    link: '#2B7FFF',
    'link-hover': '#B1CDFB',
    'link-pressed': '#D8E6FD',
    info: '#51A2FF',
    'info-bold': '#8EC5FF',
    notice: '#FF9933',
    'notice-bold': '#FFB366',
    negative: '#EA3333',
    'negative-bold': '#EF6666',
    positive: '#33AD5C',
    'positive-bold': '#66C285',
  },

  background: {
    DEFAULT: '#191919', // Background Primary
    hover: '#333333',
    pressed: '#4D4D4D',
    selected: '#1E417B',
    disabled: '#333333',
    inverse: '#FFFFFF',
    brand: '#80AEF9',
    'brand-hover': '#B1CDFB',
    'brand-pressed': '#D8E6FD',
    info: '#5C77FF',
    'info-subtle': '#142266',
    notice: '#FF9933',
    'notice-subtle': '#663300',
    negative: '#EA3333',
    'negative-subtle': '#5C0000',
    positive: '#33AD5C',
    'positive-subtle': '#003D14',
  },

  border: {
    DEFAULT: '#999999', // Border Primary
    secondary: '#666666',
    tertiary: '#333333',
    disabled: '#4D4D4D',
    brand: '#80AEF9',
    inverse: '#191919',
    focus: '#51A2FF',
    info: '#5C77FF',
    notice: '#FF9933',
    negative: '#EA3333',
    positive: '#33AD5C',
    mono: '#FFFFFF',
  },

  // Elevation: higher number = lighter = closer to the user.
  surface: {
    0: '#0D0D0D',
    1: '#191919',
    2: '#262626', // list cards, tab bar, bottom sheet
    3: '#333333', // merchant terminal panel
    4: '#404040',
    5: '#4D4D4D',
    6: '#595959',
  },

  overlay: {
    DEFAULT: 'rgba(0, 0, 0, 0.5)',
    inverse: 'rgba(255, 255, 255, 0.5)',
  },

  // ---- Used in design/screens but not on the color sheet. Confirm with the designer. ----
  primary: {
    DEFAULT: '#3B82F6', // filled brand blue: balance cards, CTA, Tappi button, active tab, scan frame
    600: '#4A75ED', // progress bars, tx avatars
    700: '#295BAC', // tap-to-pay banner, chart bars
    800: '#1E417B', // = background.selected (Brand 800)
    900: '#12274A', // quick-action tiles, stat tiles
  },
  usdc: '#9548FE', // USDC amounts
  track: '#D9D9D9', // progress track
  card: '#202530', // physical card footer
};
