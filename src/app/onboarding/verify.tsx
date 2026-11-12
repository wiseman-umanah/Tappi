import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';

import { CodeBoxes } from '@/components/code-boxes';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { tapFeedback } from '@/lib/feedback';
import { sendSignInCode, verifySignInCode } from '@/lib/pollar';
import { useSession } from '@/lib/session';

const LENGTH = 6;

/** The code Pollar emailed. Pollar checks it; Tappi then signs in with that Pollar session. */
export default function VerifyStep() {
  const params = useLocalSearchParams<{ email: string }>();
  const { signIn } = useSession();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const submitted = useRef('');

  const verify = useMutation({
    mutationFn: (value: string) => verifySignInCode(value),
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
    mutationFn: () => sendSignInCode(params.email),
    onSuccess: () => {
      setCode('');
      submitted.current = '';
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
          editable={!verify.isPending}
          autoFocus
          errorKey={errorKey}
          accessibilityLabel="6-digit code"
        />
      </View>

      <View className="mt-6 items-center">
        {verify.isPending ? (
          <Text className="text-sm text-content-tertiary">Checking…</Text>
        ) : verify.isError ? (
          <Text className="text-center text-sm text-content-negative">{verify.error.message}</Text>
        ) : resend.isError ? (
          <Text className="text-center text-sm text-content-negative">{resend.error.message}</Text>
        ) : null}
        <Text
          weight="medium"
          className="mt-4 text-sm text-primary"
          onPress={() => !resend.isPending && resend.mutate()}
          accessibilityRole="button">
          {resend.isPending ? 'Sending…' : resend.isSuccess ? 'Sent. Send another code' : 'Send a new code'}
        </Text>
      </View>
    </OnboardingShell>
  );
}
