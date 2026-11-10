import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NfcPulse } from '@/components/motion/nfc-pulse';
import { ScanFrame } from '@/components/motion/scan-frame';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { tapFeedback } from '@/lib/feedback';
import { naira } from '@/lib/format';
import { useNfcBroadcast } from '@/lib/nfc';
import { usePaymentRequest, useRefreshMoney } from '@/lib/queries';
import colors from '@/theme/colors';

/**
 * Merchant side of a charge: broadcast it over NFC (Android development builds) and offer a QR
 * code + short code for every other phone. Polls until the customer pays.
 */
export default function ChargeScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const request = usePaymentRequest(id, true);
  const refresh = useRefreshMoney();
  const r = request.data;
  const pending = r?.state === 'pending';
  // `via` tells the customer's phone how the link arrived, so the payment records the channel.
  const nfc = useNfcBroadcast(pending ? `${r.link}?via=nfc` : null);
  const [showQr, setShowQr] = useState(false);
  const announced = useRef<string | null>(null);

  // No NFC on this phone: go straight to the QR code.
  const qrVisible = showQr || !nfc.broadcasting;

  useEffect(() => {
    if (!r || announced.current === r.state) return;
    announced.current = r.state;
    if (r.state === 'pending') tapFeedback('ready');
    if (r.state === 'paid') {
      tapFeedback('success');
      refresh();
    }
    if (r.state === 'expired') tapFeedback('timeout');
  }, [r, refresh]);

  const cancel = useMutation({
    mutationFn: () => api(`/requests/${id}/cancel`, { method: 'POST' }),
    onSettled: () => router.back(),
  });

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar close onBack={() => (pending ? cancel.mutate() : router.back())} />

      {!r ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : !pending ? (
        <View className="flex-1 items-center justify-center">
          <TapResult
            outcome={r.state === 'paid' ? 'success' : 'timeout'}
            title={r.state === 'paid' ? 'Payment received' : r.state === 'expired' ? 'Charge expired' : 'Charge cancelled'}
            detail={naira(r.amount)}
          />
          <Button label="New charge" onPress={() => router.back()} className="mt-10 self-stretch" />
        </View>
      ) : (
        <>
          <View className="flex-1 items-center justify-center">
            {qrVisible ? (
              <View className="items-center">
                <View className="rounded-3xl bg-white p-4">
                  <QRCode value={`${r.link}?via=qr`} size={200} color={colors.surface[1]} backgroundColor="#FFFFFF" />
                </View>
                <Text className="mt-5 text-xs text-content-tertiary">or enter this code in Tappi</Text>
                <Text weight="bold" className="mt-1 text-[28px] tracking-[6px]">
                  {r.code}
                </Text>
              </View>
            ) : (
              <ScanFrame>
                <NfcPulse size={200} />
              </ScanFrame>
            )}
            <Text weight="medium" className="mt-10 text-center text-base">
              {qrVisible ? 'Ask the customer to scan with Tappi' : 'Ask the customer to tap their phone'}
            </Text>
            <Text className="mt-1 text-center text-xs text-content-tertiary">{`Charging ${naira(r.amount)} · ${r.tag}`}</Text>
          </View>

          {nfc.broadcasting ? (
            <Button
              label={showQr ? 'Back to tap' : "Can't tap? Show QR code"}
              variant={showQr ? 'secondary' : 'primary'}
              icon={showQr ? 'rfid-line' : 'qr-code-line'}
              onPress={() => setShowQr((v) => !v)}
            />
          ) : null}
          <Button label="Cancel charge" variant="ghost" onPress={() => cancel.mutate()} loading={cancel.isPending} />
        </>
      )}
    </View>
  );
}
