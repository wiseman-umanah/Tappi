// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.data/*'],
  },
  {
    // Server-only code reads process.env at runtime; nothing here is inlined into the app bundle.
    files: ['src/server/**', 'scripts/**'],
    rules: { 'expo/no-dynamic-env-var': 'off' },
  },
]);
