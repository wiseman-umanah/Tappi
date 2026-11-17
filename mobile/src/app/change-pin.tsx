import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { CodeBoxes } from '@/components/code-boxes';
import { TapResult } from '@/components/motion/tap-result';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { tapFeedback } from '@/lib/feedback';

type Stage = 'current' | 'new' | 'confirm';

const COPY: Record<Stage, { title: string; hint: string; label: string }> = {
  current: { title: 'Enter your current PIN', hint: 'The one you use to approve payments', label: 'Current PIN' },
  new: { title: 'Choose a new PIN', hint: 'Choose 4 digits', label: 'New PIN' },
  confirm: { title: 'Confirm your new PIN', hint: 'Enter it again', label: 'Confirm new PIN' },
};

/** Profile → Change PIN: the current PIN is checked on the server before a new one is chosen. */
export default function ChangePinScreen() {
  const [stage, setStage] = useState<Stage>('current');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);

  const fail = (message: string) => {
    tapFeedback('declined');
    setError(message);
    setErrorKey((k) => k + 1);
  };

  const check = useMutation({
    mutationFn: (pin: string) => api('/me/pin/check', { body: { pin } }),
    onSuccess: () => setStage('new'),
    onError: (e) => {
      fail(e.message);
      setCurrent('');
    },
  });

  const save = useMutation({
    mutationFn: () => api('/me/pin', { body: { currentPin: current, pin: next } }),
    onSuccess: () => tapFeedback('success'),
    onError: (e) => {
      fail(e.message);
      setNext('');
      setConfirm('');
      setStage('new');
    },
  });

  const onCurrent = (value: string) => {
    setCurrent(value);
    setError(null);
    if (value.length === 4) check.mutate(value);
  };

  const onNext = (value: string) => {
    setNext(value);
    setError(null);
    if (value.length < 4) return;
    if (value === current) {
      fail('Choose a different PIN from your current one.');
      setTimeout(() => setNext(''), 400);
      return;
    }
    setTimeout(() => setStage('confirm'), 200);
  };

  const onConfirm = (value: string) => {
    setConfirm(value);
    if (value.length < 4) return;
    if (value === next) return save.mutate();
    fail("PINs didn't match. Try again.");
    setTimeout(() => {
      setNext('');
      setConfirm('');
      setStage('new');
    }, 500);
  };

  if (save.isSuccess) {
    return (
      <OnboardingShell title="" back={false} footer={<Button label="Done" onPress={() => router.back()} />}>
        <View className="mt-16 items-center">
          <TapResult outcome="success" title="PIN changed" detail="Use your new PIN for your next payment." />
        </View>
      </OnboardingShell>
    );
  }

  const busy = check.isPending || save.isPending;
  const values = { current, new: next, confirm };
  const handlers = { current: onCurrent, new: onNext, confirm: onConfirm };

  return (
    <OnboardingShell title={COPY[stage].title} subtitle="Your PIN approves every payment, so keep it to yourself.">
      <View className="items-center">
        <CodeBoxes
          key={stage}
          length={4}
          value={values[stage]}
          onChangeText={handlers[stage]}
          secure
          autoFocus
          editable={!busy}
          errorKey={errorKey}
          accessibilityLabel={COPY[stage].label}
        />
        <Text className="mt-8 text-sm text-content-tertiary">
          {check.isPending ? 'Checking…' : save.isPending ? 'Saving…' : COPY[stage].hint}
        </Text>
        {error ? <Text className="mt-2 text-center text-sm text-content-negative">{error}</Text> : null}
      </View>
    </OnboardingShell>
  );
}
