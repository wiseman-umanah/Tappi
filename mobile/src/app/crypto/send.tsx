import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CryptoPicker } from '@/components/crypto-picker';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import type { CryptoAsset } from '@/lib/api-types';
import { money } from '@/lib/format';
import { useCryptoNetworks, useMe } from '@/lib/queries';
import colors from '@/theme/colors';

/** Sends USDT, USDC or Bitcoin to an outside address (Bitnob). The address is checked by the server. */
export default function SendCrypto() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const networks = useCryptoNetworks();
  const [asset, setAsset] = useState<CryptoAsset>('USDT');
  const [chain, setChain] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const balance = me.data?.wallet?.balances[asset] ?? 0;
  const value = Number(amount) || 0;
  const tooMuch = value > balance;
  const label = networks.data?.[asset].find((n) => n.chain === chain)?.label ?? chain ?? '';
  const canContinue = Boolean(chain) && address.trim().length >= 10 && value > 0 && !tooMuch;

  const next = () => {
    if (!chain) return;
    const to = address.trim();
    router.push({
      pathname: '/approve',
      params: { action: 'crypto', asset, chain, address: to, amount, name: `${to.slice(0, 6)}…${to.slice(-4)} (${label})` },
    });
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="Send crypto" />
      </View>
      <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
        {networks.data ? (
          <CryptoPicker
            asset={asset}
            onAsset={(a) => {
              setAsset(a);
              setChain(null);
              setAmount('');
            }}
            networks={networks.data[asset]}
            chain={chain}
            onChain={setChain}
          />
        ) : (
          <ActivityIndicator className="mt-10" color="#FFFFFF" />
        )}

        <Text className="mb-2 mt-6 text-xs text-content-tertiary">To address</Text>
        <TextInput
          value={address}
          onChangeText={(t) => setAddress(t.replace(/\s/g, ''))}
          placeholder={chain ? `${label} address` : 'Pick a network first'}
          placeholderTextColor={colors.content.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          editable={Boolean(chain)}
          className="rounded-2xl border border-border-disabled bg-surface-1 px-4 py-4 font-sans text-sm text-white"
        />

        <View className="mt-8">
          <MoneyInput asset={asset} value={amount} onChangeText={setAmount} />
          <Text className={tooMuch ? 'mt-2 text-center text-xs text-content-negative' : 'mt-2 text-center text-xs text-content-tertiary'}>
            {tooMuch ? 'More than your balance' : `Balance ${money(balance, asset)}`}
          </Text>
        </View>
        <Text className="mt-6 text-center text-[11px] text-content-tertiary">
          Check the address and network: crypto sent to the wrong place can&apos;t be brought back.
        </Text>
      </ScrollView>
      <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Button label="Continue" onPress={next} disabled={!canContinue} />
      </View>
    </KeyboardAvoidingView>
  );
}
