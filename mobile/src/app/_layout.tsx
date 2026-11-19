import '../global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { RestoreAccount } from '@/components/restore-account';
import { TappiLogo } from '@/components/tappi-logo';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/queries';
import { SessionProvider, useSession } from '@/lib/session';
import colors from '@/theme/colors';
import { fonts } from '@/theme/fonts';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary.DEFAULT,
    background: colors.background.DEFAULT,
    card: colors.surface[2],
    border: colors.border.DEFAULT,
  },
};

/** Shown when the phone has a session but can't reach the backend (laptop off, other Wi-Fi). */
function Offline({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <TappiLogo size={40} />
      <Text weight="bold" className="mt-6 text-lg">
        Can&apos;t reach Tappi
      </Text>
      <Text className="mt-2 text-center text-sm text-content-tertiary">{message}</Text>
      <Button label="Try again" onPress={onRetry} loading={retrying} className="mt-8 self-stretch" />
    </View>
  );
}

function RootNavigator({ fontsReady }: { fontsReady: boolean }) {
  const { status } = useSession();
  const me = useMe();
  const resolving = status === 'loading' || (status === 'signedIn' && me.isPending);
  const ready = status === 'signedIn' && me.data != null && !me.data.needsProfile && me.data.hasPin;

  useEffect(() => {
    if (fontsReady && !resolving) SplashScreen.hideAsync();
  }, [fontsReady, resolving]);

  if (!fontsReady || resolving) return null;
  if (status === 'signedIn' && me.isError && !me.data) {
    return <Offline message={me.error.message} onRetry={() => me.refetch()} retrying={me.isFetching} />;
  }
  if (status === 'signedIn' && me.data?.account.status === 'deleting') return <RestoreAccount me={me.data} />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background.DEFAULT } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="assistant" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="pay/index" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
        <Stack.Screen name="pay/scan" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
        <Stack.Screen name="pay/[code]" />
        <Stack.Screen name="charge/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="approve" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="send/index" />
        <Stack.Screen name="send/[handle]" />
        <Stack.Screen name="swap" />
        <Stack.Screen name="add-money" options={{ presentation: 'modal' }} />
        <Stack.Screen name="withdraw" />
        <Stack.Screen name="crypto/receive" />
        <Stack.Screen name="crypto/send" />
        <Stack.Screen name="usd-card" />
        <Stack.Screen name="merchant/index" />
        <Stack.Screen name="change-pin" />
        <Stack.Screen name="delete-account" />
      </Stack.Protected>
      <Stack.Protected guard={!ready}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fonts);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background.DEFAULT }}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            <RootNavigator fontsReady={fontsLoaded || Boolean(fontError)} />
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
