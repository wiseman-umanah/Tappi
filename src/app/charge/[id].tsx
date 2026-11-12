import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeBoxes } from '@/components/code-boxes';
import { Icon } from '@/components/icon';
import { NfcPulse } from '@/components/motion/nfc-pulse';
import { ScanFrame } from '@/components/motion/scan-frame';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Asset, CardBrand, CardPaid, CardResult, TapClaim } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { tapFeedback } from '@/lib/feedback';
import { money } from '@/lib/format';
import { goBack } from '@/lib/nav';
import { useNearbyBeacon } from '@/lib/nearby';
import { useNfcTerminal } from '@/lib/nfc';
import { usePaymentRequest, useRefreshMoney } from '@/lib/queries';
import colors from '@/theme/colors';

/** How long the reader waits for a tap before putting the QR code up by itself. */
const TAP_TIMEOUT_MS = 30_000;

/**
 * Merchant side of a charge. The phone is the reader: a customer's Tappi phone or a bank card
 * taps it (Android development builds). No tap after 30 seconds, or a phone that can't read, and
 * the QR code + short code go up instead. Polls until the charge is paid.
 */
export default function ChargeScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const request = usePaymentRequest(id, true);
  const refresh = useRefreshMoney();
  const r = request.data;
  const pending = r?.state === 'pending';
  const [card, setCard] = useState<CardBrand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showQr, setShowQr] = useState<boolean | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const announced = useRef<string | null>(null);

  const claim = useMutation({
    mutationFn: (token: string) => api<TapClaim>(`/requests/${id}/tap`, { body: { token } }),
    onSuccess: () => {
      tapFeedback('success', { sound: false });
      setNotice(null);
      request.refetch();
    },
    onError: (error) => {
      tapFeedback('declined');
      setNotice(error.message);
    },
  });

  // A customer's Tappi card: Tappi builds the payment and their phone (unlocked for Tap to pay)
  // signs it through Pollar within a few seconds; this screen sees the charge turn paid.
  const cardTap = useMutation({
    mutationFn: (token: string) => api<CardPaid>(`/requests/${id}/tappi-card`, { body: { token } }),
    onSuccess: () => {
      setNotice(null);
      request.refetch();
    },
    onError: (error) => {
      tapFeedback('declined');
      setNotice(error.message);
    },
  });

  const nfc = useNfcTerminal(pending && !card, async (read) => {
    if (read.kind === 'phone') await claim.mutateAsync(read.token).catch(() => {});
    else if (read.kind === 'tappiCard') await cardTap.mutateAsync(read.token).catch(() => {});
    else if (read.kind === 'card') {
      tapFeedback('success', { sound: false });
      setNotice(null);
      setCard(read.brand);
    } else {
      tapFeedback('declined');
      setNotice("That isn't a Tappi phone or a bank card.");
    }
  });

  // Customers around see this charge in their Pay → Nearby list (Bluetooth).
  const beacon = useNearbyBeacon(pending && !card, r?.id);

  useEffect(() => {
    if (!nfc.listening || !pending) return;
    const timer = setTimeout(() => setTimedOut(true), TAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [nfc.listening, pending]);

  // Phones that can't read go straight to the QR code; otherwise it appears after the timeout,
  // and the merchant can switch either way.
  const qrVisible = showQr ?? (!nfc.listening || timedOut);

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
    onSettled: () => goBack('/merchant'),
  });
  // The X and "Cancel charge" both cancel; a second tap must not go back twice.
  const cancelCharge = () => {
    if (!cancel.isPending) cancel.mutate();
  };

  const status = !r
    ? ''
    : r.tapped
      ? `${r.tapped} tapped · waiting for their PIN`
      : qrVisible
        ? timedOut && nfc.listening
          ? 'No tap yet. Ask the customer to scan this code with Tappi'
          : 'Ask the customer to scan with Tappi'
        : beacon.visible
          ? 'Customer taps a card or phone, or picks you in Tappi'
          : 'Ask the customer to tap their card or phone';

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar close onBack={() => (pending ? cancelCharge() : goBack('/merchant'))} />

      {!r ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : !pending ? (
        <View className="flex-1 items-center justify-center">
          <TapResult
            outcome={r.state === 'paid' ? 'success' : 'timeout'}
            title={r.state === 'paid' ? 'Payment received' : r.state === 'expired' ? 'Charge expired' : 'Charge cancelled'}
            detail={r.cardBrand ? `${money(r.amount, r.asset)} · ${r.cardBrand} card` : money(r.amount, r.asset)}
          />
          <Button label="New charge" onPress={() => goBack('/merchant')} className="mt-10 self-stretch" />
        </View>
      ) : card ? (
        <CardPayment requestId={r.id} amount={r.amount} asset={r.asset} brand={card} onDone={() => request.refetch()} onCancel={() => setCard(null)} />
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
                <NfcPulse size={200} active={!claim.isPending} />
              </ScanFrame>
            )}
            <Text weight="medium" className="mt-10 text-center text-base">
              {status}
            </Text>
            <Text className={cn('mt-1 text-center text-xs', notice ? 'text-content-negative' : 'text-content-tertiary')}>
              {cardTap.isPending
                ? 'Tappi card read…'
                : cardTap.data && !notice
                  ? `Tappi card read · ${cardTap.data.holder}'s phone is paying…`
                : (notice ?? (nfc.reason && !r.tapped ? nfc.reason : `Charging ${money(r.amount, r.asset)} · ${r.tag}`))}
            </Text>
          </View>

          {nfc.listening ? (
            <Button
              label={qrVisible ? 'Back to tap' : "Can't tap? Show QR code"}
              variant={qrVisible ? 'secondary' : 'primary'}
              icon={qrVisible ? 'rfid-line' : 'qr-code-line'}
              onPress={() => setShowQr(!qrVisible)}
            />
          ) : null}
          <Button label="Cancel charge" variant="ghost" onPress={cancelCharge} loading={cancel.isPending} />
        </>
      )}
    </View>
  );
}

/**
 * A bank card tapped: real card detection, simulated charge. Charging a card needs a licensed
 * acquirer, so on testnet the PIN pad is for show and the digits never leave this screen.
 */
function CardPayment({
  requestId,
  amount,
  asset,
  brand,
  onDone,
  onCancel,
}: {
  requestId: string;
  amount: number;
  asset: Asset;
  brand: CardBrand;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const charge = useMutation({
    mutationFn: () => api<CardResult>(`/requests/${requestId}/card`, { body: { brand } }),
    onSuccess: onDone,
    onError: () => {
      tapFeedback('declined');
      setErrorKey((k) => k + 1);
      setPin('');
    },
  });

  return (
    <>
      <View className="flex-1 items-center justify-center">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-primary-600">
          <Icon name="bank-card-line" size={28} />
        </View>
        <Text weight="bold" className="mt-4 text-[22px]">
          {`${brand} card`}
        </Text>
        <Text className="mt-1 text-xs text-content-tertiary">{`Charging ${money(amount, asset)}`}</Text>

        <View className="mt-10">
          <CodeBoxes
            length={4}
            value={pin}
            onChangeText={(value) => {
              setPin(value);
              if (value.length === 4) charge.mutate();
            }}
            secure
            autoFocus
            editable={!charge.isPending}
            errorKey={errorKey}
            accessibilityLabel="Card PIN (test mode)"
          />
        </View>
        <Text className={cn('mt-6 px-4 text-center text-xs', charge.isError ? 'text-content-negative' : 'text-content-tertiary')}>
          {charge.isPending
            ? 'Confirming on Stellar…'
            : charge.isError
              ? charge.error.message
              : 'Test mode: type any 4 digits. Never enter a real card PIN here. The card is read, but not charged.'}
        </Text>
      </View>
      <Button label="Use another way to pay" variant="ghost" onPress={onCancel} disabled={charge.isPending} />
    </>
  );
}
