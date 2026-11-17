import { requireOptionalNativeModule } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

import type { CardBrand } from '@/lib/api-types';
import { readCardBrand } from '@/lib/emv';

// NFC payments. Both halves need a development build (`pnpm build:dev`):
//   - merchant phone = the reader (react-native-nfc-manager in Android reader mode). It reads
//     bank cards (src/lib/emv.ts) and customers' phones.
//   - customer phone = an NFC tag carrying `tappi://tap/<token>` (modules/tappi-hce, Android
//     only; iPhones can't present themselves, so they scan the merchant's QR code instead)
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

export type TerminalRead =
  | { kind: 'phone'; token: string }
  /** A customer's Tappi card: their phone after "Tap to pay" on the Cards screen. */
  | { kind: 'tappiCard'; token: string }
  | { kind: 'card'; brand: CardBrand }
  | { kind: 'unknown' };

/**
 * Merchant side: while `enabled`, waits for a card or phone and hands back what it was. The next
 * read starts once `onRead` settles, so one tap is handled once.
 */
export function useNfcTerminal(enabled: boolean, onRead: (read: TerminalRead) => Promise<void> | void) {
  const [lib] = useState(loadNfcManager);
  const [state, setState] = useState<{ listening: boolean; reason: string | null }>({
    listening: false,
    reason: lib ? null : NOT_IN_THIS_BUILD,
  });
  const callback = useRef(onRead);
  useEffect(() => {
    callback.current = onRead;
  });

  useEffect(() => {
    if (!lib || !enabled) return;
    const { default: NfcManager, NfcTech, NfcAdapter, Ndef } = lib;
    let active = true;

    (async () => {
      if (Platform.OS !== 'android') {
        return setState({ listening: false, reason: 'Taking taps needs an Android phone. Show the QR code instead.' });
      }
      if (!(await NfcManager.isSupported())) return setState({ listening: false, reason: "This phone doesn't have NFC." });
      await NfcManager.start();
      if (!(await NfcManager.isEnabled())) return setState({ listening: false, reason: 'Turn on NFC in Settings to take taps.' });
      // Reader mode for the whole charge: Android stops acting as a card itself and doesn't hand
      // the tag to other apps.
      await NfcManager.registerTagEvent({
        isReaderModeEnabled: true,
        readerModeFlags: NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
      });
      setState({ listening: true, reason: null });

      while (active) {
        let read: TerminalRead | null = null;
        try {
          // A Tappi phone is an NDEF tag; a bank card is plain ISO-DEP. Ndef first.
          const tech = await NfcManager.requestTechnology([NfcTech.Ndef, NfcTech.IsoDep]);
          if (tech === NfcTech.Ndef) {
            const tag = await NfcManager.getTag();
            const uri = (tag?.ndefMessage ?? []).map((r) => Ndef.uri.decodePayload(new Uint8Array(r.payload))).find(Boolean);
            const phone = uri?.match(/^tappi:\/\/tap\/([\w.-]+)/)?.[1];
            const card = uri?.match(/^tappi:\/\/card\/([\w.-]+)/)?.[1];
            read = phone ? { kind: 'phone', token: phone } : card ? { kind: 'tappiCard', token: card } : { kind: 'unknown' };
          } else if (tech === NfcTech.IsoDep) {
            const brand = await readCardBrand((apdu) => NfcManager.isoDepHandler.transceive(apdu));
            read = brand ? { kind: 'card', brand } : { kind: 'unknown' };
          }
        } catch {
          // Moved apart mid-read, or cancelled; keep listening.
        } finally {
          await NfcManager.cancelTechnologyRequest().catch(() => {});
        }
        if (read && active) await Promise.resolve(callback.current(read)).catch(() => {});
      }
    })().catch(() => setState({ listening: false, reason: "Couldn't start NFC on this phone." }));

    return () => {
      active = false;
      NfcManager.cancelTechnologyRequest().catch(() => {});
      NfcManager.unregisterTagEvent().catch(() => {});
    };
  }, [lib, enabled]);

  return state;
}

/** Whether this phone can present itself as a tag: null when the build has no Tappi NFC module. */
export const nfcPresentStatus = () => (Hce ? Hce.status() : null);

/** Customer side: presents this phone as an NFC tag carrying `link` while it's set. */
export function useNfcPresent(link: string | null) {
  const [status] = useState(nfcPresentStatus);

  useEffect(() => {
    if (!link || status !== 'ready') return;
    Hce?.broadcast(link);
    return () => Hce?.stop();
  }, [link, status]);

  const reason =
    status === 'ready'
      ? null
      : status === 'disabled'
        ? 'Turn on NFC in Settings to tap.'
        : status === 'unsupported'
          ? "This phone can't tap to pay."
          : Platform.OS === 'ios'
            ? 'iPhones can’t tap to pay yet. Scan the merchant’s QR code.'
            : NOT_IN_THIS_BUILD;
  return { ready: status === 'ready', presenting: status === 'ready' && link != null, reason };
}
