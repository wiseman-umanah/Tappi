import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { CodeBoxes } from '@/components/code-boxes';
import { Icon } from '@/components/icon';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { api } from '@/lib/api';
import type { Session } from '@/lib/api-types';
import { tapFeedback } from '@/lib/feedback';
import { useSession } from '@/lib/session';

const LENGTH = 6;
const FILL_DELAY_MS = 700;
const FILL_STEP_MS = 230;

export default function VerifyStep() {
  const params = useLocalSearchParams<{ email: string; devCode?: string }>();
  const { signIn } = useSession();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState(params.devCode || '');
  const [autoFilling, setAutoFilling] = useState(Boolean(params.devCode));
  const [errorKey, setErrorKey] = useState(0);
  const submitted = useRef('');

  const verify = useMutation({
    mutationFn: (value: string) => api<Session>('/auth/verify', { body: { email: params.email, code: value } }),
    onSuccess: async ({ token, ...me }) => {
      tapFeedback('success', { sound: false });
      queryClient.setQueryData(['me'], me);
      await signIn(token);
      // Finished accounts land in the app automatically (see the guards in app/_layout.tsx).
      if (me.needsProfile) router.replace('/onboarding/profile');
      else if (!me.hasPin) router.replace('/onboarding/pin');
    },
    onError: () => {
      setErrorKey((k) => k + 1);
      setCode('');
      submitted.current = '';
    },
  });

  const resend = useMutation({
    mutationFn: () => api<{ devCode?: string }>('/auth/code', { body: { email: params.email } }),
    onSuccess: ({ devCode: next }) => {
      setCode('');
      submitted.current = '';
      if (next) {
        setDevCode(next);
        setAutoFilling(true);
      }
    },
  });

  const onChange = useCallback(
    (value: string) => {
      setCode(value);
      if (value.length === LENGTH && submitted.current !== value) {
        submitted.current = value;
        verify.mutate(value);
      }
    },
    [verify],
  );

  // Test version: the backend hands us the code, and we type it in one box at a time.
  useEffect(() => {
    if (!autoFilling || !devCode) return;
    const timers = devCode.split('').map((_, i) =>
      setTimeout(() => {
        tapFeedback('ready', { sound: false });
        onChange(devCode.slice(0, i + 1));
        if (i === devCode.length - 1) setAutoFilling(false);
      }, FILL_DELAY_MS + i * FILL_STEP_MS),
    );
    return () => timers.forEach(clearTimeout);
    // onChange changes every render while verify runs; the sequence must start only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFilling, devCode]);

  return (
    <OnboardingShell
      step={2}
      title="Enter the code"
      subtitle={
        <>
          Sent to <Text className="text-sm text-white">{params.email}</Text>
        </>
      }>
      <View className="items-center">
        <CodeBoxes
          length={LENGTH}
          value={code}
          onChangeText={onChange}
          editable={!autoFilling && !verify.isPending}
          autoFocus={!params.devCode}
          errorKey={errorKey}
          accessibilityLabel="6-digit code"
        />
      </View>

      {devCode ? (
        <View className="mt-6 flex-row items-center justify-center gap-1.5 rounded-full bg-background-selected px-4 py-2">
          <Icon name="magic-line" size={14} className="text-primary" />
          <Text className="text-xs text-content-link-hover">
            {autoFilling ? 'Test version: filling in your code…' : 'Test version: Tappi filled in your code'}
          </Text>
        </View>
      ) : null}

      <View className="mt-6 items-center">
        {verify.isPending ? (
          <Text className="text-sm text-content-tertiary">Checking…</Text>
        ) : verify.isError ? (
          <Text className="text-center text-sm text-content-negative">{verify.error.message}</Text>
        ) : null}
        <Text
          weight="medium"
          className="mt-4 text-sm text-primary"
          onPress={() => !resend.isPending && resend.mutate()}
          accessibilityRole="button">
          {resend.isPending ? 'Sending…' : 'Send a new code'}
        </Text>
      </View>
    </OnboardingShell>
  );
}
