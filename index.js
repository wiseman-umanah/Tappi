// App entry. Pollar's SDK (src/lib/pollar.ts) signs every request with a device key, which needs
// crypto.getRandomValues and a full URL on Hermes: load those before anything else.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

import 'expo-router/entry';
