import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import { CodeBoxes } from '@/components/code-boxes';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { api } from '@/lib/api';
import { tapFeedback } from '@/lib/feedback';

export default function PinStep() {
  const queryClient = useQueryClient();
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const [stage, setStage] = useState<'create' | 'confirm'>('create');
  const [errorKey, setErrorKey] = useState(0);
  const [mismatch, setMismatch] = useState(false);

  const save = useMutation({
    mutationFn: (pin: string) => api('/me/pin', { body: { pin } }),
    // Once the PIN exists the guards in app/_layout.tsx open the app.
    onSuccess: async () => {
      tapFeedback('success');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const onCreate = (value: string) => {
    setFirst(value);
    setMismatch(false);
    if (value.length === 4) setTimeout(() => setStage('confirm'), 200);
  };

  const onConfirm = (value: string) => {
    setConfirm(value);
    if (value.length < 4) return;
    if (value === first) return save.mutate(value);
    setMismatch(true);
    setErrorKey((k) => k + 1);
    setTimeout(() => {
      setFirst('');
      setConfirm('');
      setStage('create');
    }, 500);
  };

  return (
    <OnboardingShell
      step={4}
      back={false}
      title={stage === 'create' ? 'Create your PIN' : 'Confirm your PIN'}
      subtitle="You'll enter this 4-digit PIN to approve every payment.">
      <View className="items-center">
        {stage === 'create' ? (
          <CodeBoxes key="create" length={4} value={first} onChangeText={onCreate} secure autoFocus errorKey={errorKey} accessibilityLabel="New PIN" />
        ) : (
          <CodeBoxes key="confirm" length={4} value={confirm} onChangeText={onConfirm} secure autoFocus editable={!save.isPending} accessibilityLabel="Confirm PIN" />
        )}
        <Text className="mt-8 text-sm text-content-tertiary">
          {save.isPending ? 'Saving…' : mismatch ? '' : stage === 'create' ? 'Choose 4 digits' : 'Enter it again'}
        </Text>
        {mismatch ? <Text className="mt-2 text-sm text-content-negative">PINs didn&apos;t match. Try again.</Text> : null}
        {save.isError ? <Text className="mt-2 text-sm text-content-negative">{save.error.message}</Text> : null}
      </View>
    </OnboardingShell>
  );
}
