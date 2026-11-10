import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NfcPulse } from '@/components/motion/nfc-pulse';
import { ScanFrame } from '@/components/motion/scan-frame';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { tapFeedback } from '@/lib/feedback';
import { useNfcReader } from '@/lib/nfc';
import { parsePayLink } from '@/lib/pay-link';
import colors from '@/theme/colors';

// Design: design/screens/10-nfc-tap-to-pay.png
// Customer side of a Tappi-to-Tappi payment: read the merchant's charge by NFC, or — for phones
// that can't tap — scan its QR code or type its 6-character code. Nobody is left out.
export default function PayScreen() {
  const insets = useSafeAreaInsets();
  const [typing, setTyping] = useState(false);
  const [code, setCode] = useState('');
  const open = (value: string, channel: 'nfc' | 'qr' | 'code') =>
    router.replace({ pathname: '/pay/[code]', params: { code: value, channel } });

  const nfc = useNfcReader((link) => {
    const found = parsePayLink(link);
    if (found) {
      tapFeedback('success', { sound: false });
      open(found, 'nfc');
    }
  });

  useEffect(() => {
    if (nfc.listening) tapFeedback('ready');
  }, [nfc.listening]);

  const typed = parsePayLink(code);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background px-5"
      style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar close />

      <View className="flex-1 items-center justify-center">
        {typing ? null : (
          <ScanFrame>
            <NfcPulse size={200} active={nfc.listening} />
          </ScanFrame>
        )}
        <Text weight="medium" className="mt-14 text-center text-base">
          {nfc.listening ? 'Hold your phone near the merchant’s phone' : 'Pay a Tappi merchant'}
        </Text>
        <Text className="mt-1 px-6 text-center text-xs text-content-tertiary">
          {nfc.listening
            ? 'Works with any Tappi merchant · settles on Stellar'
            : nfc.reason ?? 'Scan the QR code on the merchant’s phone, or type the code under it.'}
        </Text>
      </View>

      {typing ? (
        <View className="mb-4">
          <TextInput
            value={code}
            onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="6-character code"
            placeholderTextColor={colors.content.disabled}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={() => typed && open(typed, 'code')}
            className="rounded-2xl border border-border-disabled bg-surface-1 px-4 py-4 text-center font-sans-bold text-2xl tracking-[6px] text-white"
          />
          <Button label="Continue" onPress={() => typed && open(typed, 'code')} disabled={!typed} className="mt-3" />
        </View>
      ) : (
        <View className="gap-1">
          <Button label={nfc.listening ? "Can't tap? Scan QR code" : 'Scan QR code'} icon="qr-scan-2-line" onPress={() => router.push('/pay/scan')} />
          <Button label="Enter code instead" variant="ghost" onPress={() => setTyping(true)} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
