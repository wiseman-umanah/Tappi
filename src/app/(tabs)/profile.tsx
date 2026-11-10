import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { HandleHint } from '@/components/handle-hint';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListCard } from '@/components/ui/list-card';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import type { Gender, Me } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { openExternal } from '@/lib/links';
import { useHandleCheck, useMe } from '@/lib/queries';
import { useSession } from '@/lib/session';
import colors from '@/theme/colors';

// Designs: design/screens/09-profile.png, 15-profile-edit-sheet.png
type FieldProps = { label: string; prefix?: string; hint?: React.ReactNode } & React.ComponentProps<typeof TextInput>;

function Field({ label, prefix, hint, ...props }: FieldProps) {
  return (
    <View className="mb-4">
      <Text className="mb-1.5 text-xs text-content-tertiary">{label}</Text>
      <View className="flex-row items-center rounded-xl border border-border-disabled bg-surface-1 px-4">
        {prefix ? <Text className="text-sm text-content-tertiary">{prefix}</Text> : null}
        <TextInput
          placeholderTextColor={colors.content.disabled}
          autoCorrect={false}
          className="flex-1 py-3 font-sans text-sm text-white"
          {...props}
        />
      </View>
      {hint}
    </View>
  );
}

function EditProfileSheet({ me, visible, onClose }: { me: Me; visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.user.name ?? '');
  const [handle, setHandle] = useState(me.user.handle ?? '');
  const [gender, setGender] = useState<Gender>(me.user.gender ?? 'female');
  const check = useHandleCheck(handle, name, me.user.handle);

  const save = useMutation({
    mutationFn: () => api<Me>('/me', { method: 'PATCH', body: { name: name.trim(), handle, gender } }),
    onSuccess: (data) => {
      queryClient.setQueryData(['me'], data);
      onClose();
    },
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-overlay" onPress={onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View className="rounded-t-[32px] bg-surface-2 px-6 pt-8" style={{ paddingBottom: insets.bottom + 24 }}>
          <View className="mb-6 flex-row items-center justify-between">
            <Text weight="bold" className="text-xl">
              Edit profile
            </Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="close-line" size={22} />
            </Pressable>
          </View>
          <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
          <Field
            label="Username"
            prefix="@"
            value={handle}
            onChangeText={(t) => setHandle(t.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20))}
            autoCapitalize="none"
            hint={<HandleHint check={check} onPick={setHandle} />}
          />
          <Text className="mb-1.5 text-xs text-content-tertiary">Avatar</Text>
          <View className="mb-4 flex-row gap-3">
            {(['female', 'male'] as const).map((g) => (
              <Pressable
                key={g}
                onPress={() => setGender(g)}
                accessibilityRole="radio"
                accessibilityState={{ selected: gender === g }}
                className={cn(
                  'flex-1 flex-row items-center gap-3 rounded-xl border-2 bg-surface-1 px-3 py-2',
                  gender === g ? 'border-primary' : 'border-border-tertiary',
                )}>
                <Avatar gender={g} size={36} />
                <Text className="text-sm capitalize">{g}</Text>
              </Pressable>
            ))}
          </View>
          {save.isError ? <Text className="mb-3 text-sm text-content-negative">{save.error.message}</Text> : null}
          <Button
            label="Save"
            onPress={() => save.mutate()}
            loading={save.isPending}
            disabled={name.trim().length < 2 || (check.state !== 'available' && check.state !== 'current')}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type RowProps = { icon: IconName; label: string; value?: string; onPress?: () => void; danger?: boolean };

function Row({ icon, label, value, onPress, danger }: RowProps) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} className="flex-row items-center gap-3 px-4 py-3.5 active:bg-surface-3">
      <Icon name={icon} size={18} className={danger ? 'text-content-negative' : 'text-content-tertiary'} />
      <Text className={cn('flex-1 text-sm', danger && 'text-content-negative')}>{label}</Text>
      {value ? (
        <Text className="text-xs text-content-tertiary" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {onPress ? <Icon name="arrow-right-s-line" size={18} className="text-content-disabled" /> : null}
    </Pressable>
  );
}

export default function ProfileScreen() {
  const me = useMe();
  const { signOut } = useSession();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<'handle' | 'address' | null>(null);
  const data = me.data;
  if (!data) return <Screen title="Profile" subtitle="Your account, security and preferences" withTabBar />;

  const copy = async (what: 'handle' | 'address', text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  const address = data.wallet?.publicKey ?? '';
  const explorer = data.wallet?.explorer;
  const receiving = data.account.status === 'active';

  return (
    <Screen title="Profile" subtitle="Your account, security and preferences" withTabBar>
      <View className="flex-row items-center gap-4">
        <Avatar gender={data.user.gender} size={84} />
        <View className="flex-1">
          <Text weight="bold" className="text-xl">
            {data.user.name}
          </Text>
          <Pressable onPress={() => copy('handle', `@${data.user.handle}`)} hitSlop={6} className="mt-0.5 flex-row items-center gap-1">
            <Text className="text-sm text-primary">{copied === 'handle' ? 'Copied!' : `@${data.user.handle}`}</Text>
            <Icon name={copied === 'handle' ? 'check-line' : 'file-copy-line'} size={12} className="text-primary" />
          </Pressable>
          <View className="mt-1.5 flex-row gap-1.5">
            <Badge label="Email verified" tone="positive" />
            <Badge label="Testnet" />
          </View>
        </View>
        <Pressable
          onPress={() => setEditing(true)}
          accessibilityLabel="Edit profile"
          className="h-9 w-9 items-center justify-center rounded-full border border-border">
          <Icon name="pencil-line" size={16} />
        </Pressable>
      </View>

      {data.wallet ? (
        <View className="mt-8 rounded-2xl bg-primary-900 p-4">
          <View className="flex-row items-center gap-2">
            <Icon name="wallet-3-line" size={16} className="text-primary" />
            <Text weight="medium" className="flex-1 text-sm">
              Stellar wallet
            </Text>
            <Badge label="Testnet" tone="noticeOutline" />
          </View>
          <Text className="mt-3 font-sans-medium text-xs text-content-secondary" selectable>
            {`${address.slice(0, 12)}…${address.slice(-12)}`}
          </Text>
          <Text className="mt-1 text-[10px] text-content-tertiary">
            Held securely by Tappi. Fees are covered for you — no XLM needed.
          </Text>
          <View className="mt-4 flex-row gap-2">
            <Pressable onPress={() => copy('address', address)} className="flex-row items-center gap-1 rounded-full bg-primary-800 px-3 py-2">
              <Icon name={copied === 'address' ? 'check-line' : 'file-copy-line'} size={12} />
              <Text className="text-xs">{copied === 'address' ? 'Copied!' : 'Copy address'}</Text>
            </Pressable>
            <Pressable onPress={() => explorer && openExternal(explorer)} className="flex-row items-center gap-1 rounded-full bg-primary-800 px-3 py-2">
              <Icon name="external-link-line" size={12} />
              <Text className="text-xs">View on explorer</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ListCard className="mt-6">
        <Row icon="mail-line" label="Email" value={data.user.email ?? undefined} />
        <Row icon="lock-password-line" label="Change PIN" onPress={() => router.push('/change-pin')} />
      </ListCard>

      <ListCard className="mt-6">
        <View className="flex-row items-center gap-3 px-4 py-3.5">
          <Icon name="user-forbid-line" size={18} className="text-content-tertiary" />
          <View className="flex-1">
            <Text className="text-sm">Receive payments</Text>
            <Text className="mt-0.5 text-[10px] text-content-tertiary">
              {receiving ? 'People can send you money and pay your charges' : 'Account disabled — no money can come in'}
            </Text>
          </View>
          <Toggle
            value={receiving}
            onValueChange={(enabled) =>
              router.push({ pathname: '/approve', params: { action: enabled ? 'enable' : 'disable', amount: '0' } })
            }
            accessibilityLabel="Receive payments"
          />
        </View>
        <Row icon="delete-bin-line" label="Delete account" onPress={() => router.push('/delete-account')} danger />
      </ListCard>

      <Button label="Sign out" variant="secondary" icon="logout-box-r-line" onPress={signOut} className="mt-8" />

      <EditProfileSheet key={String(editing)} me={data} visible={editing} onClose={() => setEditing(false)} />
    </Screen>
  );
}
