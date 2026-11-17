import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScanFrame } from '@/components/motion/scan-frame';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { tapFeedback } from '@/lib/feedback';
import { parsePayLink, parseSendLink } from '@/lib/pay-link';

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  // A merchant's charge (tappi://pay/CODE) or a person's Receive code (tappi://send/username).
  const onScan = ({ data }: { data: string }) => {
    if (handled.current) return;
    const code = parsePayLink(data);
    const handle = code ? null : parseSendLink(data);
    if (!code && !handle) return;
    handled.current = true;
    tapFeedback('success', { sound: false });
    if (code) router.replace({ pathname: '/pay/[code]', params: { code, channel: 'qr' } });
    else if (handle) router.replace({ pathname: '/send', params: { to: handle } });
  };

  return (
    <View className="flex-1 bg-black" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScan}
        />
      ) : null}
      <View className="px-5">
        <TopBar close />
      </View>
      <View className="flex-1 items-center justify-center px-8">
        {permission?.granted ? (
          <>
            <ScanFrame size={240} />
            <Text weight="medium" className="mt-10 text-center text-base">
              Point at the Tappi QR code on their phone
            </Text>
          </>
        ) : (
          <>
            <Text weight="medium" className="text-center text-base">
              Tappi needs the camera to scan payment QR codes
            </Text>
            <Text className="mt-2 text-center text-xs text-content-tertiary">
              {permission && !permission.canAskAgain
                ? 'Camera access is off. Turn it on in Settings, or go back and enter the code instead.'
                : 'In a browser this needs an https address — if it fails, go back and type the code instead.'}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Button label="Allow camera" onPress={requestPermission} className="mt-8 self-stretch" />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
