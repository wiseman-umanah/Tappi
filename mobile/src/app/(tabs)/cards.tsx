import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeBoxes } from '@/components/code-boxes';
import { Icon } from '@/components/icon';
import { NfcPulse } from '@/components/motion/nfc-pulse';
import { ScanFrame } from '@/components/motion/scan-frame';
import { TapResult } from '@/components/motion/tap-result';
import { Screen } from '@/components/screen';
import { TappiLogo } from '@/components/tappi-logo';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { ListCard } from '@/components/ui/list-card';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import type { ArmedCard, Asset, TappiCard, TappiCardDetails } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { tapFeedback } from '@/lib/feedback';
import { money, naira, nairaShort } from '@/lib/format';
import { nfcPresentStatus, useNfcPresent } from '@/lib/nfc';
import { setPreference, usePreferences } from '@/lib/preferences';
import { unlockPhone } from '@/lib/unlock';

// Design: design/screens/07-cards.png (the linked bank cards list is left out for now).
// The Tappi card (testnet: simulated) spends from the wallet. "Tap to pay" unlocks the phone,
// then the phone presents the card to a merchant's terminal for a minute; the merchant's phone
// reads it and the charge is paid — no Tappi PIN, the unlock was the approval.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const FOIL = ['#FF8F8F', '#FFB86B', '#FFE8A3', '#7FE7D9', '#5EA8FF', '#A98BFF', '#FF8FCB'] as const;
const FROZEN = ['#4D4D4D', '#666666', '#3A3A3A'] as const;
/** How long revealed card details stay on screen. */
const REVEAL_MS = 30_000;

function useCard() {
  return useQuery({ queryKey: ['card'], queryFn: () => api<TappiCard>('/card') });
}

function HoloCard({ card, details }: { card: TappiCard; details: TappiCardDetails | null }) {
  return (
    <View className="overflow-hidden rounded-3xl">
      <View style={{ aspectRatio: 1.9 }}>
        <LinearGradient colors={card.frozen ? FROZEN : FOIL} start={{ x: 0, y: 0.2 }} end={{ x: 1, y: 0.8 }} style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,255,255,0.35)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0.25)']}
          start={{ x: 1, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View className="absolute right-4 top-4 h-9 w-9 items-center justify-center rounded-full bg-black">
          <TappiLogo size={18} />
        </View>
        {card.frozen ? (
          <View className="absolute left-4 top-4 flex-row items-center gap-1 rounded-full bg-black/60 px-2.5 py-1">
            <Icon name="snowflake-line" size={12} />
            <Text weight="medium" className="text-[10px]">
              Frozen
            </Text>
          </View>
        ) : null}
        <View className="flex-1 justify-end px-6 pb-5">
          <Text
            weight="bold"
            numberOfLines={1}
            adjustsFontSizeToFit
            selectable={Boolean(details)}
            className="text-lg text-black"
            style={{ fontFamily: MONO, letterSpacing: 0.5 }}>
            {details ? details.number : `•••• •••• •••• ${card.last4}`}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center justify-between bg-card px-6 py-5">
        <Text weight="bold" className="flex-1 text-sm" numberOfLines={1}>
          {card.holder}
        </Text>
        {details ? (
          <Text className="mr-4 text-sm">
            CVV{' '}
            <Text weight="bold" className="text-sm" style={{ fontFamily: MONO }}>
              {details.cvv}
            </Text>
          </Text>
        ) : null}
        <Text className="text-sm">
          Exp{' '}
          <Text weight="bold" className="text-sm" style={{ fontFamily: MONO }}>
            {card.expiry}
          </Text>
        </Text>
      </View>
    </View>
  );
}

/** Bottom sheet asking for the Tappi PIN. */
function PinSheet({
  visible,
  title,
  detail,
  busy,
  error,
  onPin,
  onClose,
}: {
  visible: boolean;
  title: string;
  detail: string;
  busy: boolean;
  error: string | null;
  onPin: (pin: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [pin, setPin] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== shown.current) setErrorKey((k) => k + 1);
    shown.current = error;
  }, [error]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-overlay" onPress={onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View className="items-center rounded-t-[32px] bg-surface-2 px-6 pt-8" style={{ paddingBottom: insets.bottom + 24 }}>
          <Text weight="bold" className="text-xl">
            {title}
          </Text>
          <Text className="mb-6 mt-1 text-center text-xs text-content-tertiary">{detail}</Text>
          <CodeBoxes
            length={4}
            value={pin}
            onChangeText={(value) => {
              setPin(value);
              if (value.length === 4) {
                onPin(value);
                setPin('');
              }
            }}
            secure
            autoFocus
            editable={!busy}
            errorKey={errorKey}
            accessibilityLabel="Tappi PIN"
          />
          <Text className={cn('mt-5 text-center text-xs', error ? 'text-content-negative' : 'text-content-tertiary')}>
            {busy ? 'Checking…' : (error ?? 'Your 4-digit Tappi PIN')}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * "Tap to pay": the card is armed for a minute and this phone presents it over NFC. Closes itself
 * once a merchant has charged it.
 */
function TapToPay({ armed, baseline, onClose }: { armed: ArmedCard; baseline: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const nfc = useNfcPresent(armed.link);
  const until = new Date(armed.armedUntil).getTime();
  const [left, setLeft] = useState(() => Math.max(0, Math.round((until - Date.now()) / 1000)));
  const card = useQuery({
    queryKey: ['card'],
    queryFn: () => api<TappiCard>('/card'),
    refetchInterval: 1500,
  });
  const paid = card.data?.lastPayment && card.data.lastPayment.id !== baseline ? card.data.lastPayment : null;

  useEffect(() => {
    tapFeedback('ready');
    const timer = setInterval(() => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000))), 500);
    return () => clearInterval(timer);
  }, [until]);
  useEffect(() => {
    if (paid) {
      tapFeedback('success');
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    } else if (left === 0) tapFeedback('timeout');
  }, [paid, left === 0, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-overlay">
        <View className="items-center rounded-t-[32px] bg-surface-2 px-6 pt-8" style={{ paddingBottom: insets.bottom + 24 }}>
          {paid ? (
            <>
              <TapResult outcome="success" title="Paid" detail={`${money(paid.amount, paid.asset)} · ${paid.merchant}`} />
              <Button label="Done" onPress={onClose} className="mt-8 self-stretch" />
            </>
          ) : left === 0 ? (
            <>
              <TapResult outcome="timeout" title="Card put away" detail="No merchant read it in time." />
              <Button label="Close" variant="secondary" onPress={onClose} className="mt-8 self-stretch" />
            </>
          ) : (
            <>
              <ScanFrame size={170}>
                <NfcPulse size={150} active={nfc.presenting} />
              </ScanFrame>
              <Text weight="bold" className="mt-6 text-lg">
                Hold to the merchant’s phone
              </Text>
              <Text className="mt-1 text-center text-xs text-content-tertiary">
                {nfc.reason ?? `Back to back, near the top · ${left}s`}
              </Text>
              <Button label="Cancel" variant="ghost" onPress={onClose} className="mt-6 self-stretch" />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function SettingRow({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <View className="flex-1">
        <Text weight="medium" className="text-sm">
          {title}
        </Text>
        <Text className="mt-0.5 text-[10px] text-content-tertiary">{detail}</Text>
      </View>
      {children}
    </View>
  );
}

export default function CardsScreen() {
  const queryClient = useQueryClient();
  const card = useCard();
  const prefs = usePreferences();
  const [details, setDetails] = useState<TappiCardDetails | null>(null);
  const [pinFor, setPinFor] = useState<'details' | 'tap' | null>(null);
  const [armed, setArmed] = useState<{ card: ArmedCard; baseline: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canTap] = useState(() => nfcPresentStatus() === 'ready');
  const c = card.data;

  // Revealed details hide themselves again.
  useEffect(() => {
    if (!details) return;
    const timer = setTimeout(() => setDetails(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [details]);

  const update = useMutation({
    mutationFn: (input: Partial<Pick<TappiCard, 'frozen' | 'dailyLimit' | 'fundingAsset'>>) =>
      api<TappiCard>('/card', { method: 'PATCH', body: input }),
    onSuccess: (data) => queryClient.setQueryData(['card'], data),
    onError: (error) => setNotice(error.message),
  });

  const reveal = useMutation({
    mutationFn: (pin: string) => api<TappiCardDetails>('/card/details', { body: { pin } }),
    onSuccess: (data) => {
      setDetails(data);
      setPinFor(null);
    },
  });

  const arm = useMutation({
    mutationFn: (pin?: string) => api<ArmedCard>('/card/arm', { body: pin ? { pin } : {} }),
    onSuccess: (data) => {
      setPinFor(null);
      setArmed({ card: data, baseline: c?.lastPayment?.id ?? null });
    },
    onError: (error) => {
      if (pinFor !== 'tap') setNotice(error.message);
    },
  });

  const tapToPay = async () => {
    setNotice(null);
    if (!prefs.unlockBeforeTap) return arm.mutate(undefined);
    const result = await unlockPhone('Unlock to pay with your Tappi card');
    if (result === 'ok') arm.mutate(undefined);
    // No screen lock on this phone: the Tappi PIN stands in.
    else if (result === 'unavailable') setPinFor('tap');
  };

  const closeTap = () => {
    setArmed(null);
    api('/card/arm', { method: 'DELETE' }).catch(() => {});
    card.refetch();
  };

  if (!c) {
    return (
      <Screen title="Cards" subtitle="Your Tappi card and tap preferences" withTabBar>
        {card.isError ? (
          <Text className="mt-16 text-center text-sm text-content-tertiary">{card.error.message}</Text>
        ) : (
          <ActivityIndicator className="mt-16" color="#FFFFFF" />
        )}
      </Screen>
    );
  }

  const spentShare = Math.min(1, c.spentToday / Math.max(1, c.dailyLimit));

  return (
    <Screen title="Cards" subtitle="Your Tappi card and tap preferences" withTabBar>
      <View className="mt-2 px-5">
        <HoloCard card={c} details={details} />
      </View>

      <View className="mt-6 flex-row gap-2">
        <Button
          label="Tap to pay"
          icon="rfid-line"
          onPress={tapToPay}
          loading={arm.isPending && pinFor !== 'tap'}
          disabled={c.frozen || !canTap}
          className="flex-1"
        />
        <Button
          label={details ? 'Hide details' : 'Show details'}
          icon={details ? 'eye-off-line' : 'eye-line'}
          variant="secondary"
          onPress={() => (details ? setDetails(null) : setPinFor('details'))}
          className="flex-1"
        />
      </View>
      <Text className={cn('mt-2 text-center text-[10px]', notice ? 'text-content-negative' : 'text-content-tertiary')}>
        {notice ??
          (c.frozen
            ? 'Unfreeze the card to pay with it.'
            : canTap
              ? 'Pays a merchant’s Tappi terminal in one tap · test card, not a real one'
              : 'Tapping the card needs an Android phone with NFC (the Tappi app build). Use Pay → Scan QR instead.')}
      </Text>

      <Text className="mb-2 mt-8 text-xs text-content-tertiary">Card controls</Text>
      <ListCard>
        <SettingRow title="Freeze card" detail={c.frozen ? 'Nothing can be paid with it' : 'Stop all card payments at once'}>
          <Toggle value={c.frozen} onValueChange={(frozen) => update.mutate({ frozen })} accessibilityLabel="Freeze card" />
        </SettingRow>
        <SettingRow title="Pay from" detail="Charges in the other currency are converted at the live rate">
          <View className="flex-row gap-1">
            {(['NGN', 'USDC'] as Asset[]).map((asset) => (
              <Pressable
                key={asset}
                onPress={() => update.mutate({ fundingAsset: asset })}
                accessibilityRole="radio"
                accessibilityState={{ selected: c.fundingAsset === asset }}
                className={cn('rounded-full px-3 py-1.5', c.fundingAsset === asset ? 'bg-primary' : 'bg-surface-3')}>
                <Text weight="medium" className="text-xs">
                  {asset === 'NGN' ? 'Naira' : 'USDC'}
                </Text>
              </Pressable>
            ))}
          </View>
        </SettingRow>
        <View className="px-4 py-3">
          <View className="flex-row items-center justify-between">
            <Text weight="medium" className="text-sm">
              Daily limit
            </Text>
            <Text className="text-xs text-content-tertiary">{`${naira(c.spentToday, 0)} of ${naira(c.dailyLimit, 0)} today`}</Text>
          </View>
          <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <View className="h-full rounded-full bg-primary" style={{ width: `${spentShare * 100}%` }} />
          </View>
          <View className="mt-3 flex-row flex-wrap gap-1.5">
            {c.limits.map((limit) => (
              <Pressable
                key={limit}
                onPress={() => update.mutate({ dailyLimit: limit })}
                accessibilityRole="radio"
                accessibilityState={{ selected: c.dailyLimit === limit }}
                className={cn(
                  'rounded-full border px-3 py-1.5',
                  c.dailyLimit === limit ? 'border-primary bg-background-selected' : 'border-border-disabled',
                )}>
                <Text className={cn('text-[11px]', c.dailyLimit !== limit && 'text-content-tertiary')}>{nairaShort(limit, 0)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </ListCard>

      <Text className="mb-2 mt-6 text-xs text-content-tertiary">Tap preferences · this phone</Text>
      <ListCard>
        <SettingRow title="Unlock before tapping" detail="Fingerprint, face or screen lock before the card pays">
          <Toggle
            value={prefs.unlockBeforeTap}
            onValueChange={(value) => setPreference('unlockBeforeTap', value)}
            accessibilityLabel="Unlock before tapping"
          />
        </SettingRow>
        <SettingRow title="Tap sound & haptics" detail="Chimes, beeps and buzzes for taps and payments">
          <Toggle
            value={prefs.tapSound}
            onValueChange={(value) => setPreference('tapSound', value)}
            accessibilityLabel="Tap sound and haptics"
          />
        </SettingRow>
      </ListCard>

      <PinSheet
        key={pinFor ?? 'closed'}
        visible={pinFor !== null}
        title={pinFor === 'tap' ? 'Unlock your card' : 'Show card details'}
        detail={
          pinFor === 'tap'
            ? 'This phone has no screen lock, so enter your Tappi PIN to pay.'
            : 'Number, expiry and CVV show for 30 seconds.'
        }
        busy={pinFor === 'tap' ? arm.isPending : reveal.isPending}
        error={pinFor === 'tap' ? (arm.error?.message ?? null) : (reveal.error?.message ?? null)}
        onPin={(pin) => (pinFor === 'tap' ? arm.mutate(pin) : reveal.mutate(pin))}
        onClose={() => setPinFor(null)}
      />
      {armed ? <TapToPay armed={armed.card} baseline={armed.baseline} onClose={closeTap} /> : null}
    </Screen>
  );
}
