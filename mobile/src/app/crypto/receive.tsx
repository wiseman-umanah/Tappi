import { useMutation } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CryptoPicker } from '@/components/crypto-picker';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { CryptoAsset, DepositAddress } from '@/lib/api-types';
import { useCryptoNetworks } from '@/lib/queries';
import colors from '@/theme/colors';

/** The user's own deposit address for a coin on a network (Bitnob). Deposits land in their balance. */
export default function ReceiveCrypto() {
  const insets = useSafeAreaInsets();
  const networks = useCryptoNetworks();
  const [asset, setAsset] = useState<CryptoAsset>('USDT');
  const [chain, setChain] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const address = useMutation({
    mutationFn: (input: { asset: CryptoAsset; chain: string }) => api<DepositAddress>('/crypto/address', { body: input }),
  });
  const shown = address.data && address.data.asset === asset && address.data.chain === chain ? address.data : null;
  const label = networks.data?.[asset].find((n) => n.chain === chain)?.label ?? chain;

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar title="Receive crypto" />
      <ScrollView contentContainerClassName="pb-6" showsVerticalScrollIndicator={false}>
        {networks.data ? (
          <CryptoPicker
            asset={asset}
            onAsset={(a) => {
              setAsset(a);
              setChain(null);
            }}
            networks={networks.data[asset]}
            chain={chain}
            onChain={setChain}
          />
        ) : networks.isError ? (
          <Text className="mt-6 text-sm text-content-negative">{networks.error.message}</Text>
        ) : (
          <ActivityIndicator className="mt-10" color="#FFFFFF" />
        )}

        {shown ? (
          <View className="mt-8 items-center">
            <View className="rounded-2xl bg-white p-4">
              <QRCode value={shown.address} size={180} color={colors.surface[1]} backgroundColor="#FFFFFF" />
            </View>
            <Pressable onPress={() => copy(shown.address)} accessibilityLabel="Copy address" className="mt-5 flex-row items-center gap-2 px-2">
              <Text weight="medium" className="flex-shrink text-center text-sm" selectable>
                {shown.address}
              </Text>
              <Icon name={copied ? 'check-line' : 'file-copy-line'} size={16} className="text-primary" />
            </Pressable>
            <View className="mt-6 flex-row gap-2 rounded-2xl bg-surface-2 p-4">
              <Icon name="error-warning-line" size={16} className="text-content-notice" />
              <Text className="flex-1 text-xs text-content-secondary">
                {`Only send ${asset} on ${label} to this address. Anything else, or another network, can't be recovered.`}
              </Text>
            </View>
          </View>
        ) : chain ? (
          <View className="mt-8">
            <Button label="Show my address" onPress={() => address.mutate({ asset, chain })} loading={address.isPending} />
            {address.isError ? <Text className="mt-3 text-sm text-content-negative">{address.error.message}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
