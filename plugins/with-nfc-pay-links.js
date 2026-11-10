// Tapping a merchant's phone while Tappi is closed (or on another screen) should open the charge.
// Android delivers NFC tags as NDEF_DISCOVERED, which Expo's `intentFilters` can't express (it
// prefixes every action with android.intent.action.), so add the filter to the main activity here.
// React Native reads NDEF_DISCOVERED data like any deep link, so expo-router opens /pay/<CODE>.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const ACTION = 'android.nfc.action.NDEF_DISCOVERED';

module.exports = function withNfcPayLinks(config, { scheme = 'tappi' } = {}) {
  return withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    activity['intent-filter'] ??= [];
    const exists = activity['intent-filter'].some((f) => f.action?.some((a) => a.$['android:name'] === ACTION));
    if (!exists) {
      activity['intent-filter'].push({
        action: [{ $: { 'android:name': ACTION } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:scheme': scheme, 'android:host': 'pay' } }],
      });
    }
    return mod;
  });
};
