import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

/** Opens an outside page (Stellar explorer): a new browser tab on web, the browser on a phone. */
export function openExternal(url: string) {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else Linking.openURL(url);
}
