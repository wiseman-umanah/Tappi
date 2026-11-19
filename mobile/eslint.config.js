// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.data/*'],
  },
  {
    // Node scripts read process.env at runtime; nothing here is inlined into the app bundle.
    files: ['scripts/**'],
    rules: { 'expo/no-dynamic-env-var': 'off' },
  },
]);
