import { requireOptionalNativeModule } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

// Tappi-to-Tappi NFC. Both halves need a development build (`pnpm build:dev`):
//   - merchant phone broadcasts the open charge as an NFC tag (modules/tappi-hce, Android only)
//   - customer phone reads it with react-native-nfc-manager (Android; iPhone needs a paid
//     Apple account and iOS 16.4+)
// Expo Go, the browser and phones without NFC report a reason instead, and the screens fall back
// to the QR code and the typed code.

type HceModule = { status(): 'unsupported' | 'disabled' | 'ready'; broadcast(uri: string): void; stop(): void };
const Hce = Platform.OS === 'android' ? requireOptionalNativeModule<HceModule>('TappiHce') : null;

type NfcLib = typeof import('react-native-nfc-manager');

/** react-native-nfc-manager throws on import when its native half is missing, so load it lazily. */
function loadNfcManager(): NfcLib | null {
  if (Platform.OS === 'web') return null;
  const native = TurboModuleRegistry.get('NfcManager') ?? NativeModules.NfcManager;
  if (!native) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must not load in Expo Go
    return require('react-native-nfc-manager') as NfcLib;
  } catch {
    return null;
  }
}

const NOT_IN_THIS_BUILD =
  Platform.OS === 'web' ? "Tapping isn't available in the browser." : 'Tapping needs the Tappi app build, not Expo Go.';

/** Customer side: listens for a merchant's phone and hands back the link it carries. */
export function useNfcReader(onLink: (link: string) => void) {
  const [lib] = useState(loadNfcManager);
  const [state, setState] = useState<{ listening: boolean; reason: string | null }>({
    listening: false,
    reason: lib ? null : NOT_IN_THIS_BUILD,
  });
  const callback = useRef(onLink);
  useEffect(() => {
    callback.current = onLink;
  });

  useEffect(() => {
    if (!lib) return;
    const { default: NfcManager, NfcTech, Ndef } = lib;
    let active = true;

    (async () => {
      if (!(await NfcManager.isSupported())) return setState({ listening: false, reason: "This phone doesn't have NFC." });
      await NfcManager.start();
      if (!(await NfcManager.isEnabled())) return setState({ listening: false, reason: 'Turn on NFC in Settings to tap.' });
      setState({ listening: true, reason: null });

      while (active) {
        try {
          await NfcManager.requestTechnology(NfcTech.Ndef, { alertMessage: "Hold near the merchant's phone" });
          const tag = await NfcManager.getTag();
          for (const record of tag?.ndefMessage ?? []) {
            const uri = Ndef.uri.decodePayload(new Uint8Array(record.payload));
            if (uri) callback.current(uri);
          }
        } catch {
          // Cancelled or the phones moved apart; keep listening.
        } finally {
          await NfcManager.cancelTechnologyRequest().catch(() => {});
        }
        // iOS shows a system sheet per attempt; don't reopen it in a loop.
        if (Platform.OS === 'ios') break;
      }
    })().catch(() => setState({ listening: false, reason: "Couldn't start NFC on this phone." }));

    return () => {
      active = false;
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, [lib]);

  return state;
}

/** Merchant side: broadcasts `link` while it's set (an open charge), stops when it's null. */
export function useNfcBroadcast(link: string | null) {
  const [ready] = useState(() => Hce?.status() === 'ready');

  useEffect(() => {
    if (!link || !ready) return;
    Hce?.broadcast(link);
    return () => Hce?.stop();
  }, [link, ready]);

  return { broadcasting: ready && link != null };
}
