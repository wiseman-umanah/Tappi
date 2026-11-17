import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

/**
 * The phone's own unlock (fingerprint, face, or the screen-lock PIN/pattern) before a card tap.
 * 'unavailable' when the phone has no screen lock at all — callers then ask for the Tappi PIN.
 */
export async function unlockPhone(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'unavailable';
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success ? 'ok' : 'cancelled';
  } catch {
    return 'unavailable';
  }
}
