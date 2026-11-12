import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/icon';
import { NfcPulse } from '@/components/motion/nfc-pulse';
import { ScanFrame } from '@/components/motion/scan-frame';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListCard } from '@/components/ui/list-card';
import { SegmentedTabs } from '@/components/ui/segmented-tabs';
import { api } from '@/lib/api';
import type { PendingTap, PersonTap, TapToken } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { tapFeedback } from '@/lib/feedback';
import { money } from '@/lib/format';
import { goHome } from '@/lib/nav';
import { useNearbyBeacon, useNearbyScan, type NearbyPhone } from '@/lib/nearby';
import { nfcPresentStatus, useNfcPresent, useNfcTerminal } from '@/lib/nfc';
import { parsePayLink, parseSendLink, sendLink } from '@/lib/pay-link';
import { useMe } from '@/lib/queries';
import colors from '@/theme/colors';

// Design: design/screens/10-nfc-tap-to-pay.png
// Tap mode. Pay: this phone looks for Tappi phones around it (Bluetooth, with a beep for each one
// found) and presents itself over NFC, so touching a phone on Receive or a merchant's terminal
// picks them. Nothing after a while → "Didn't find a phone" with three ways on: try again, scan
// their QR code, or type their code / @username. Receive: this phone is findable and reads the
// payer's phone; its QR code and @username are on screen for phones that can't tap.

/** How long Pay looks before offering the other ways. */
const SEARCH_MS = 15_000;
const PING_MS = 2_500;
/** Bluetooth signal strength → 1–3 bars. */
const bars = (rssi: number) => (rssi > -60 ? 3 : rssi > -75 ? 2 : 1);

type Mode = 'pay' | 'receive';
const MODES = [
  { key: 'pay', label: 'Pay' },
  { key: 'receive', label: 'Receive' },
] as const;

export default function TapModeScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: Mode }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'receive' ? 'receive' : 'pay');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background px-5"
      style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar close onBack={goHome} />
      <SegmentedTabs tabs={MODES} value={mode} onChange={setMode} className="mt-3" />
      {/* Keyed so leaving a tab stops its NFC and Bluetooth work. */}
      {mode === 'pay' ? <PayMode key="pay" /> : <ReceiveMode key="receive" />}
    </KeyboardAvoidingView>
  );
}

// ---------------- Pay ----------------

function PayMode() {
  const [typing, setTyping] = useState(false);
  const [entry, setEntry] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [missed, setMissed] = useState(false);
  const opened = useRef(false);

  const leave = (to: { code: string; channel: 'nfc' | 'qr' | 'code' | 'nearby' } | { handle: string }) => {
    if (opened.current) return;
    opened.current = true;
    if ('code' in to) router.replace({ pathname: '/pay/[code]', params: { code: to.code, channel: to.channel } });
    else router.replace({ pathname: '/send', params: { to: to.handle } });
  };

  // NFC: present this phone so a merchant's terminal or a phone on Receive can read it.
  const [canTap] = useState(() => nfcPresentStatus() === 'ready');
  const token = useQuery({
    queryKey: ['tap-token'],
    queryFn: () => api<TapToken>('/taps', { method: 'POST' }),
    enabled: canTap && !typing,
    gcTime: 0,
    refetchInterval: 90_000, // a fresh token before the old one (2 minutes) runs out
  });
  const nfc = useNfcPresent(typing ? null : (token.data?.link ?? null));

  // Did their phone read this one? Only taps from now on: backing out of a charge and reopening
  // Pay mustn't bounce straight back into it.
  const [since] = useState(() => new Date().toISOString());
  const tapped = useQuery({
    queryKey: ['tap-pending', since],
    queryFn: () => api<PendingTap>(`/taps?since=${encodeURIComponent(since)}`),
    enabled: nfc.presenting,
    gcTime: 0,
    refetchInterval: 1500,
  });
  useEffect(() => {
    const t = tapped.data;
    if (!t?.charge && !t?.person) return;
    tapFeedback('success', { sound: false });
    if (t.charge) leave({ code: t.charge.code, channel: 'nfc' });
    else if (t.person) leave({ handle: t.person.handle });
  });

  // Bluetooth: who's around, with a beep for each one that shows up.
  const scan = useNearbyScan(!typing, () => tapFeedback('found'));
  const phones = scan.phones;
  const searching = nfc.presenting || scan.scanning;

  // Pinging while looking; after SEARCH_MS with nobody found, offer the other ways.
  useEffect(() => {
    if (typing || !searching || phones.length > 0 || missed) return;
    tapFeedback('ready', { sound: false });
    const ping = setInterval(() => tapFeedback('ping'), PING_MS);
    const giveUp = setTimeout(() => {
      clearInterval(ping);
      tapFeedback('timeout');
      setMissed(true);
    }, SEARCH_MS);
    return () => {
      clearInterval(ping);
      clearTimeout(giveUp);
    };
  }, [typing, searching, phones.length, missed, attempt]);

  // Neither NFC nor Bluetooth works on this phone (iPhone, Expo Go, browser, both switched off):
  // straight to the other ways. Each radio reports a reason once it knows it can't be used.
  const cantSearch = scan.reason !== null && (!canTap || nfc.reason !== null || token.isError);
  const showMissed = !typing && phones.length === 0 && (missed || cantSearch);

  const submitEntry = () => {
    const value = entry.trim();
    const handle = value.startsWith('@') ? parseSendLink(value) : null;
    const code = handle ? null : parsePayLink(value);
    if (code) return leave({ code, channel: 'code' });
    const person = handle ?? (/^[a-z0-9_]{3,20}$/i.test(value) ? value.toLowerCase() : null);
    if (person) leave({ handle: person });
  };
  const entryOk = Boolean(parsePayLink(entry) || parseSendLink(entry) || /^[a-z0-9_]{3,20}$/i.test(entry.trim()));

  const reason = scan.reason ?? nfc.reason ?? (token.isError ? token.error.message : null);

  if (typing) {
    return (
      <View className="flex-1 justify-end">
        <View className="flex-1 items-center justify-center">
          <Text weight="medium" className="text-center text-base">
            Enter their code
          </Text>
          <Text className="mt-1 px-6 text-center text-xs text-content-tertiary">
            The 6-character code under a merchant’s QR code, or a person’s @username.
          </Text>
        </View>
        <TextInput
          value={entry}
          onChangeText={(t) => setEntry(t.replace(/[^A-Za-z0-9_@]/g, '').slice(0, 21))}
          placeholder="AB2CD3 or @username"
          placeholderTextColor={colors.content.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={submitEntry}
          className="rounded-2xl border border-border-disabled bg-surface-1 px-4 py-4 text-center font-sans-bold text-xl tracking-[3px] text-white"
        />
        <Button label="Continue" onPress={submitEntry} disabled={!entryOk} className="mt-3" />
        <Button label="Back to tap" variant="ghost" onPress={() => setTyping(false)} />
      </View>
    );
  }

  return (
    <>
      <View className="flex-1">
        {showMissed ? (
          <View className="flex-1 items-center justify-center px-4">
            <View className="h-20 w-20 items-center justify-center rounded-full bg-surface-2">
              <Icon name="rfid-line" size={34} className="text-content-tertiary" />
            </View>
            <Text weight="bold" className="mt-6 text-center text-lg">
              {cantSearch ? 'Pay by QR code or code' : 'Didn’t find a phone'}
            </Text>
            <Text className="mt-2 text-center text-xs text-content-tertiary">
              {cantSearch
                ? (reason ?? 'This phone can’t tap. Scan their QR code, or type their code.')
                : 'Ask them to open Tappi → NFC Payment → Receive, then try again. Or scan their QR code, or type their code.'}
            </Text>
          </View>
        ) : (
          <>
            <View className={cn('items-center justify-center', phones.length ? 'pt-6' : 'flex-1')}>
              <ScanFrame size={phones.length ? 130 : 220}>
                <NfcPulse size={phones.length ? 110 : 190} active={searching} />
              </ScanFrame>
              <Text weight="medium" className="mt-8 text-center text-base">
                {phones.length ? 'Pick who to pay, or touch phones' : 'Hold your phone to theirs'}
              </Text>
              <Text className="mt-1 px-6 text-center text-xs text-content-tertiary">
                {reason ?? 'Looking for Tappi phones nearby… They need Tappi open on Receive.'}
              </Text>
            </View>
            {phones.length ? (
              <ScrollView className="mt-5 flex-1" showsVerticalScrollIndicator={false}>
                <Text className="mb-2 text-xs text-content-tertiary">Nearby</Text>
                <ListCard>
                  {phones.map((p) => (
                    <NearbyRow
                      key={`${p.kind}:${p.handle}`}
                      phone={p}
                      onPress={() =>
                        p.charge ? leave({ code: p.charge.code, channel: 'nearby' }) : leave({ handle: p.handle })
                      }
                    />
                  ))}
                </ListCard>
              </ScrollView>
            ) : null}
          </>
        )}
      </View>

      <View className="gap-1 pt-3">
        {showMissed && !cantSearch ? (
          <Button
            label="Try again"
            icon="refresh-line"
            onPress={() => {
              setMissed(false);
              setAttempt((n) => n + 1);
            }}
          />
        ) : null}
        <Button
          label="Scan QR code"
          icon="qr-scan-2-line"
          variant={showMissed && !cantSearch ? 'secondary' : 'primary'}
          onPress={() => router.push('/pay/scan')}
        />
        <Button label="Enter code instead" variant="ghost" onPress={() => setTyping(true)} />
      </View>
    </>
  );
}

function NearbyRow({ phone, onPress }: { phone: NearbyPhone; onPress: () => void }) {
  const strength = bars(phone.rssi);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="flex-row items-center gap-3 px-4 py-3 active:bg-surface-3">
      <Avatar gender={phone.gender} size={40} />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text weight="medium" className="text-sm" numberOfLines={1}>
            {phone.name}
          </Text>
          {phone.charge ? <Badge label="Merchant" /> : null}
        </View>
        <Text className="mt-0.5 text-xs text-content-tertiary" numberOfLines={1}>
          {phone.charge ? `${money(phone.charge.amount, phone.charge.asset)} · ${phone.charge.tag}` : `@${phone.handle}`}
        </Text>
      </View>
      <View className="flex-row items-end gap-0.5" accessibilityLabel={`Signal ${strength} of 3`}>
        {[1, 2, 3].map((n) => (
          <View key={n} className={cn('w-1 rounded-full', n <= strength ? 'bg-primary' : 'bg-surface-3')} style={{ height: 4 + n * 4 }} />
        ))}
      </View>
      <Icon name="arrow-right-s-line" size={18} className="text-content-disabled" />
    </Pressable>
  );
}

// ---------------- Receive ----------------

function ReceiveMode() {
  const queryClient = useQueryClient();
  const me = useMe();
  // Only balances fetched after Receive opened count as the starting point (the cache may be stale).
  const [openedAt] = useState(() => Date.now());
  const user = me.data?.user;
  const balances = me.data?.wallet?.balances;
  const [payer, setPayer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [received, setReceived] = useState<{ amount: number; asset: 'NGN' | 'USDC' } | null>(null);
  const start = useRef<{ NGN: number; USDC: number } | null>(null);

  // Findable by payers around (Bluetooth) while this tab is open.
  const beacon = useNearbyBeacon(!received);

  // The payer's phone touches this one: tell their phone to open Send to us.
  const claim = useMutation({
    mutationFn: (token: string) => api<PersonTap>('/taps/person', { body: { token } }),
    onSuccess: (data) => {
      tapFeedback('success', { sound: false });
      setNotice(null);
      setPayer(data.payer);
    },
    onError: (error) => {
      tapFeedback('declined');
      setNotice(error.message);
    },
  });
  const nfc = useNfcTerminal(!received, async (read) => {
    if (read.kind === 'phone') await claim.mutateAsync(read.token).catch(() => {});
    else {
      tapFeedback('declined');
      setNotice(
        read.kind === 'card' || read.kind === 'tappiCard'
          ? 'Cards pay merchants. Take card payments in the Merchant terminal, or ask them to open Pay.'
          : 'That isn’t a Tappi phone.',
      );
    }
  });

  // Watch the balance: whatever comes in while Receive is open (tap, nearby, QR) shows here.
  const fresh = me.dataUpdatedAt >= openedAt;
  useEffect(() => {
    if (!balances || !fresh) return;
    if (!start.current) {
      start.current = balances;
      return;
    }
    const asset = balances.NGN > start.current.NGN + 1e-7 ? 'NGN' : balances.USDC > start.current.USDC + 1e-7 ? 'USDC' : null;
    if (!asset || received) return;
    setReceived({ asset, amount: balances[asset] - start.current[asset] });
    tapFeedback('success');
  }, [balances, fresh, received]);
  useEffect(() => {
    if (received) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['me'] });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [received, queryClient]);

  if (!user?.handle) return <View className="flex-1" />;

  if (received) {
    return (
      <View className="flex-1 items-center justify-center">
        <TapResult outcome="success" title="Money received" detail={`${money(received.amount, received.asset)}${payer ? ` · ${payer}` : ''}`} />
        <Button
          label="Receive more"
          variant="secondary"
          onPress={() => {
            start.current = balances ?? null;
            setPayer(null);
            setReceived(null);
          }}
          className="mt-10 self-stretch"
        />
        <Button label="Done" variant="ghost" onPress={goHome} className="self-stretch" />
      </View>
    );
  }

  const status = payer
    ? `${payer} tapped · waiting for them to send`
    : beacon.visible
      ? 'People nearby can find you'
      : nfc.listening
        ? 'Hold their phone to yours'
        : 'Show them your code';
  const detail = notice ?? (payer ? 'It shows up here as soon as it lands.' : (beacon.reason ?? nfc.reason ?? 'They open NFC Payment → Pay in Tappi and pick you.'));

  return (
    <ScrollView className="flex-1" contentContainerClassName="items-center pb-4 pt-6" showsVerticalScrollIndicator={false}>
      <ScanFrame size={150}>
        <NfcPulse size={130} active={beacon.visible || nfc.listening} />
      </ScanFrame>
      <Text weight="medium" className="mt-6 text-center text-base">
        {status}
      </Text>
      <Text className={cn('mt-1 px-6 text-center text-xs', notice ? 'text-content-negative' : 'text-content-tertiary')}>{detail}</Text>

      <View className="mt-8 items-center rounded-3xl bg-surface-1 px-6 py-5">
        <View className="rounded-2xl bg-white p-3">
          <QRCode value={sendLink(user.handle)} size={150} color={colors.surface[1]} backgroundColor="#FFFFFF" />
        </View>
        <Text className="mt-4 text-xs text-content-tertiary">or they type</Text>
        <Text weight="bold" className="mt-0.5 text-xl">
          {`@${user.handle}`}
        </Text>
      </View>
    </ScrollView>
  );
}
