/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  // The app is dark-only. 'class' also avoids NativeWind's web runtime throwing
  // "Cannot manually set color scheme, as dark mode is type 'media'".
  darkMode: 'class',
  theme: {
    // Replace (not extend) colors so only the design palette is available.
    colors: require('./src/theme/colors'),
    extend: {
      // Custom fonts need one family per weight on Android; don't combine with font-bold etc.
      fontFamily: {
        sans: ['CreatoDisplay-Regular'],
        'sans-light': ['CreatoDisplay-Light'],
        'sans-medium': ['CreatoDisplay-Medium'],
        'sans-bold': ['CreatoDisplay-Bold'],
        'sans-extrabold': ['CreatoDisplay-ExtraBold'],
      },
    },
  },
  plugins: [],
};
