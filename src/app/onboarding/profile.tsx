import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { HandleHint } from '@/components/handle-hint';
import { Icon } from '@/components/icon';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Gender, Me } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { useHandleCheck, useMe } from '@/lib/queries';
import colors from '@/theme/colors';

const GENDERS: { key: Gender; label: string }[] = [
  { key: 'female', label: 'Female' },
  { key: 'male', label: 'Male' },
];

type FieldProps = { label: string; prefix?: string; hint?: React.ReactNode } & React.ComponentProps<typeof TextInput>;

function Field({ label, prefix, hint, ...props }: FieldProps) {
  return (
    <View className="mb-5">
      <Text className="mb-2 text-xs text-content-tertiary">{label}</Text>
      <View className="flex-row items-center rounded-2xl border border-border-disabled bg-surface-1 px-4">
        {prefix ? <Text className="text-base text-content-tertiary">{prefix}</Text> : null}
        <TextInput
          placeholderTextColor={colors.content.disabled}
          autoCorrect={false}
          className="flex-1 py-4 font-sans text-base text-white"
          {...props}
        />
      </View>
      {hint}
    </View>
  );
}

export default function ProfileStep() {
  const queryClient = useQueryClient();
  const me = useMe();
  const [name, setName] = useState(me.data?.user.name ?? '');
  const [handle, setHandle] = useState(me.data?.user.handle ?? '');
  const [gender, setGender] = useState<Gender | null>(me.data?.user.gender ?? null);
  // Checked as they type, so nobody finds out the username is taken after pressing Continue.
  const check = useHandleCheck(handle, name, me.data?.user.handle);
  const handleOk = check.state === 'available' || check.state === 'current';
  const valid = name.trim().length >= 2 && handleOk && gender;

  const save = useMutation({
    mutationFn: () => api<Me>('/me', { method: 'PATCH', body: { name: name.trim(), handle, gender } }),
    onSuccess: (data) => {
      queryClient.setQueryData(['me'], data);
      if (!data.hasPin) router.replace('/onboarding/pin');
    },
  });

  return (
    <OnboardingShell
      step={3}
      back={false}
      title="Set up your profile"
      subtitle="This is how people find and pay you on Tappi."
      footer={
        <Button
          label={save.isPending ? 'Creating your Stellar wallet…' : 'Continue'}
          onPress={() => save.mutate()}
          disabled={!valid}
          loading={save.isPending}
        />
      }>
      <Field label="Full name" value={name} onChangeText={setName} placeholder="Victor Godwin" autoCapitalize="words" autoComplete="name" />
      <Field
        label="Username"
        prefix="@"
        value={handle}
        onChangeText={(t) => setHandle(t.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20))}
        placeholder="victorgodwin"
        autoCapitalize="none"
        hint={<HandleHint check={check} onPick={setHandle} />}
      />

      <Text className="mb-2 text-xs text-content-tertiary">Choose your avatar</Text>
      <View className="flex-row gap-3">
        {GENDERS.map((g) => {
          const selected = gender === g.key;
          return (
            <Pressable
              key={g.key}
              onPress={() => setGender(g.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              className={cn(
                'flex-1 items-center rounded-2xl border-2 bg-surface-1 py-5',
                selected ? 'border-primary bg-background-selected' : 'border-border-tertiary',
              )}>
              <Avatar gender={g.key} size={72} />
              <Text weight="medium" className="mt-3 text-sm">
                {g.label}
              </Text>
              {selected ? (
                <View className="absolute right-3 top-3 h-5 w-5 items-center justify-center rounded-full bg-primary">
                  <Icon name="check-line" size={13} />
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {save.isError ? <Text className="mt-4 text-sm text-content-negative">{save.error.message}</Text> : null}
      {save.isPending ? (
        <Text className="mt-4 text-center text-xs text-content-tertiary">
          Opening your account on Stellar testnet and adding ₦50,000 + $25 test money…
        </Text>
      ) : null}
    </OnboardingShell>
  );
}
