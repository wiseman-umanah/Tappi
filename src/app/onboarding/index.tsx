import { Redirect, router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NfcPulse } from '@/components/motion/nfc-pulse';
import { Text } from '@/components/text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/queries';
import { useSession } from '@/lib/session';

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { status } = useSession();
  const me = useMe();

  // Signed in but not finished setting up (e.g. the app was closed mid-onboarding).
  if (status === 'signedIn' && me.data) {
    return <Redirect href={me.data.needsProfile ? '/onboarding/profile' : '/onboarding/pin'} />;
  }

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <View className="mt-4 flex-row justify-end">
        <Badge label="Stellar testnet" tone="noticeOutline" />
      </View>
      <View className="flex-1 items-center justify-center">
        <NfcPulse size={220} />
        <Text weight="bold" className="mt-12 text-center text-[32px] leading-10">
          Pay with a tap.
        </Text>
        <Text className="mt-3 px-4 text-center text-sm leading-5 text-content-tertiary">
          Send, swap and pay in naira and USDC — settled on Stellar in seconds.
        </Text>
      </View>
      <Button label="Get started" onPress={() => router.push('/onboarding/email')} />
      <Text className="mt-4 text-center text-xs text-content-tertiary">
        Already have an account?{' '}
        <Text weight="medium" className="text-xs text-primary" onPress={() => router.push('/onboarding/email')}>
          Sign in
        </Text>
      </Text>
    </View>
  );
}
