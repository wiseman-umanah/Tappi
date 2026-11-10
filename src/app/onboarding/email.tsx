import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput } from 'react-native';

import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import colors from '@/theme/colors';

export default function EmailStep() {
  const [email, setEmail] = useState('');
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());

  const request = useMutation({
    mutationFn: () => api<{ devCode?: string }>('/auth/code', { body: { email: email.trim() } }),
    onSuccess: ({ devCode }) =>
      router.push({ pathname: '/onboarding/verify', params: { email: email.trim().toLowerCase(), devCode: devCode ?? '' } }),
  });

  return (
    <OnboardingShell
      step={1}
      title="What's your email?"
      subtitle="We'll send a 6-digit code to sign you in. New here? This creates your account."
      footer={<Button label="Continue" onPress={() => request.mutate()} disabled={!valid} loading={request.isPending} />}>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor={colors.content.disabled}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        autoFocus
        returnKeyType="go"
        onSubmitEditing={() => valid && request.mutate()}
        className={cn(
          'rounded-2xl border bg-surface-1 px-4 py-4 font-sans text-base text-white',
          request.isError ? 'border-border-negative' : 'border-border-disabled',
        )}
      />
      {request.isError ? <Text className="mt-2 text-xs text-content-negative">{request.error.message}</Text> : null}
    </OnboardingShell>
  );
}
