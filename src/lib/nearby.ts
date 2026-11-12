import { requireOptionalNativeModule } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

import { api } from '@/lib/api';
import type { Beacon, Nearby } from '@/lib/api-types';

// "Who's around" over Bluetooth LE (modules/tappi-nearby, Android, development build only).
//   - Receive / a merchant's open charge: useNearbyBeacon announces a short-lived random id.
//   - Pay: useNearbyScan hears ids, asks the server who they are, and lists them closest first.
// NFC still does the actual "touch to pick" (src/lib/nfc.ts); Bluetooth only finds who's near.

type Status = 'unsupported' | 'off' | 'ready';
type NearbyModule = {
  status(): Status;
  canAdvertise(): boolean;
  startAdvertising(id: string): Promise<void>;
  stopAdvertising(): void;
  startScanning(): void;
  stopScanning(): void;
  addListener(event: 'onBeacon', listener: (event: { id: string; rssi: number }) => void): { remove(): void };
  addListener(event: 'onScanError', listener: (event: { code: number }) => void): { remove(): void };
};
const Native = Platform.OS === 'android' ? requireOptionalNativeModule<NearbyModule>('TappiNearby') : null;

const NOT_IN_THIS_BUILD =
  Platform.OS === 'ios'
    ? 'Finding phones nearby works on Android for now.'
    : Platform.OS === 'web'
      ? "Finding phones nearby isn't available in the browser."
      : 'Finding phones nearby needs the Tappi app build, not Expo Go.';

/** Android 12+ asks for "Nearby devices"; older versions tie Bluetooth scanning to location. */
async function askPermission(use: 'scan' | 'advertise') {
  if (Platform.OS !== 'android') return false;
  const level = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted =
    level >= 31 ? [use === 'scan' ? P.BLUETOOTH_SCAN : P.BLUETOOTH_ADVERTISE] : use === 'scan' ? [P.ACCESS_FINE_LOCATION] : [];
  if (!wanted.length) return true;
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

const DENIED = 'Allow “Nearby devices” for Tappi in Settings to find phones around you.';
const BLUETOOTH_OFF = 'Turn on Bluetooth to find Tappi phones around you.';
/** A phone not heard for this long has left. */
const GONE_MS = 8_000;
/** Ids nobody owns (expired, not Tappi) are asked about again after this. */
const RETRY_UNKNOWN_MS = 15_000;

export type NearbyPhone = Nearby & { rssi: number };

/**
 * Pay side: lists Tappi phones in tap mode around this one, closest first. `onFound` fires once
 * for each person or merchant that shows up (for the beep).
 */
export function useNearbyScan(enabled: boolean, onFound?: (phone: NearbyPhone) => void) {
  const [phones, setPhones] = useState<NearbyPhone[]>([]);
  const [state, setState] = useState<{ scanning: boolean; reason: string | null }>({
    scanning: false,
    reason: Native ? null : NOT_IN_THIS_BUILD,
  });
  const found = useRef(onFound);
  useEffect(() => {
    found.current = onFound;
  });

  useEffect(() => {
    if (!enabled || !Native) return;
    const module = Native;
    let active = true;
    let scanning = false;
    const heard = new Map<string, { rssi: number; at: number }>();
    const known = new Map<string, { who: Nearby | null; at: number }>();
    const announced = new Set<string>();
    let asking = false;
    let shown = '';

    const subscriptions = [
      module.addListener('onBeacon', ({ id, rssi }) => heard.set(id, { rssi, at: Date.now() })),
      module.addListener('onScanError', () => {
        scanning = false;
        if (active) setState({ scanning: false, reason: "Bluetooth scanning stopped. Close and reopen Pay." });
      }),
    ];

    const start = async () => {
      if (!(await askPermission('scan'))) return active && setState({ scanning: false, reason: DENIED });
      if (!active) return;
      const status = module.status();
      if (status === 'unsupported') return setState({ scanning: false, reason: "This phone can't find others over Bluetooth." });
      if (status === 'off') return setState({ scanning: false, reason: BLUETOOTH_OFF });
      module.startScanning();
      scanning = true;
      setState({ scanning: true, reason: null });
    };

    const tick = async () => {
      if (!active) return;
      // Bluetooth switched on (or off) while the screen is open.
      if (!scanning) {
        if (module.status() === 'ready') await start().catch(() => {});
        return;
      }
      if (module.status() !== 'ready') {
        module.stopScanning();
        scanning = false;
        setState({ scanning: false, reason: BLUETOOTH_OFF });
        return;
      }
      const now = Date.now();
      for (const [id, h] of heard) if (now - h.at > GONE_MS) heard.delete(id);

      const unknown = [...heard.keys()].filter((id) => {
        const k = known.get(id);
        return !k || (!k.who && now - k.at > RETRY_UNKNOWN_MS);
      });
      if (unknown.length && !asking) {
        asking = true;
        try {
          const { nearby } = await api<{ nearby: Nearby[] }>('/nearby/resolve', { body: { ids: unknown } });
          for (const id of unknown) known.set(id, { who: nearby.find((n) => n.beacon === id) ?? null, at: Date.now() });
        } catch {
          // Offline for a moment: ask again next tick.
        } finally {
          asking = false;
        }
      }
      if (!active) return;

      // One row per person/merchant (their id changes every few minutes), closest first.
      const best = new Map<string, NearbyPhone>();
      for (const [id, h] of heard) {
        const who = known.get(id)?.who;
        if (!who) continue;
        const key = `${who.kind}:${who.handle}`;
        const current = best.get(key);
        if (!current || h.rssi > current.rssi) best.set(key, { ...who, rssi: h.rssi });
      }
      const list = [...best.entries()].sort((a, b) => b[1].rssi - a[1].rssi);
      for (const [key, phone] of list) {
        if (announced.has(key)) continue;
        announced.add(key);
        found.current?.(phone);
      }
      // Re-render only when the order or the people change, not on every signal wobble.
      const signature = list.map(([key]) => key).join('|');
      if (signature !== shown) {
        shown = signature;
        setPhones(list.map(([, phone]) => phone));
      }
    };

    start().catch(() => active && setState({ scanning: false, reason: "Couldn't start Bluetooth on this phone." }));
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
      subscriptions.forEach((s) => s.remove());
      if (scanning) module.stopScanning();
      setPhones([]);
    };
  }, [enabled]);

  return { phones, ...state };
}

/**
 * Receive side (and a merchant's open charge): announces this phone to payers around it while
 * `enabled`. The id is replaced every two minutes and dropped when the screen closes.
 */
export function useNearbyBeacon(enabled: boolean, requestId?: string | null) {
  const [state, setState] = useState<{ visible: boolean; reason: string | null }>({
    visible: false,
    reason: Native ? null : NOT_IN_THIS_BUILD,
  });

  useEffect(() => {
    if (!enabled || !Native) return;
    const module = Native;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const announce = async () => {
      if (!active) return;
      const status = module.status();
      if (status === 'unsupported' || !module.canAdvertise()) {
        return setState({ visible: false, reason: "This phone can't announce itself over Bluetooth. Payers can tap or scan instead." });
      }
      if (status === 'off') {
        setState({ visible: false, reason: 'Turn on Bluetooth so people nearby can find you.' });
        timer = setTimeout(announce, 3000); // try again once it's on
        return;
      }
      try {
        const beacon = await api<Beacon>('/nearby/beacon', { body: { requestId: requestId ?? null } });
        if (!active) return;
        await module.startAdvertising(beacon.id);
        if (!active) return module.stopAdvertising();
        setState({ visible: true, reason: null });
        timer = setTimeout(announce, 2 * 60_000);
      } catch (error) {
        if (!active) return;
        setState({ visible: false, reason: error instanceof Error ? error.message : "Couldn't announce this phone." });
        timer = setTimeout(announce, 10_000);
      }
    };

    askPermission('advertise')
      .then((granted) => (granted ? announce() : active && setState({ visible: false, reason: DENIED })))
      .catch(() => active && setState({ visible: false, reason: "Couldn't start Bluetooth on this phone." }));

    return () => {
      active = false;
      clearTimeout(timer);
      module.stopAdvertising();
      api('/nearby/beacon', { method: 'DELETE' }).catch(() => {});
    };
  }, [enabled, requestId]);

  return state;
}
