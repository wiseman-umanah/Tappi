import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeBoxes } from '@/components/code-boxes';
import { Text } from '@/components/text';
import { cn } from '@/lib/cn';

/** Bottom sheet asking for the 4-digit Tappi PIN (card details, tap to pay, closing a card). */
export function PinSheet({
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
      <KeyboardAvoidingView behavior="padding">
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
