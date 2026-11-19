import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { BankAccount } from '@/lib/api-types';
import { useBankAccount } from '@/lib/queries';

/**
 * The user's own account number (Paga): a bank transfer to it lands in their naira balance. Created
 * the first time they ask. Says so plainly when bank transfers aren't set up on the server yet.
 */
function BankAccountCard() {
  const account = useBankAccount();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api<{ account: BankAccount }>('/wallet/bank-account', { body: {} }),
    onSuccess: (data) => client.setQueryData(['bank-account'], data.account),
  });

  const copy = async (number: string) => {
    await Clipboard.setStringAsync(number);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const a = account.data;
  return (
    <View className="mt-6 rounded-2xl bg-primary-900 p-4">
      <View className="flex-row items-center gap-2">
        <Icon name="bank-line" size={16} className="text-primary" />
        <Text weight="medium" className="flex-1 text-sm">
          Your account number
        </Text>
      </View>
      {account.isPending ? (
        <ActivityIndicator className="mt-4" color="#FFFFFF" />
      ) : a ? (
        <>
          <Pressable onPress={() => copy(a.accountNumber)} accessibilityLabel="Copy account number" className="mt-3 flex-row items-center gap-2">
            <Text weight="bold" className="text-[28px] tracking-widest" selectable>
              {a.accountNumber}
            </Text>
            <Icon name={copied ? 'check-line' : 'file-copy-line'} size={18} className="text-primary" />
          </Pressable>
          <Text className="mt-1 text-xs text-content-secondary">{`${a.bankName}${a.accountName ? ` · ${a.accountName}` : ''}`}</Text>
          <Text className="mt-3 text-[11px] text-content-tertiary">
            Send naira to this account from any bank app. It lands in your Tappi naira balance.
          </Text>
        </>
      ) : (
        <>
          <Text className="mt-2 text-xs text-content-tertiary">
            Get your own account number, then add money by bank transfer from any bank.
          </Text>
          <Button label="Get my account number" onPress={() => create.mutate()} loading={create.isPending} className="mt-4" />
          {create.isError ? <Text className="mt-2 text-xs text-content-negative">{create.error.message}</Text> : null}
        </>
      )}
      {account.isError ? <Text className="mt-2 text-xs text-content-negative">{account.error.message}</Text> : null}
    </View>
  );
}

/** Add Money: the user's own account number for bank transfers, or their crypto address. */
export default function AddMoney() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <TopBar title="Add money" close />
      <ScrollView contentContainerClassName="pb-6" showsVerticalScrollIndicator={false}>
        <BankAccountCard />
        <Pressable
          onPress={() => router.replace('/crypto/receive')}
          accessibilityRole="button"
          className="mt-4 flex-row items-center gap-4 rounded-2xl border border-border-tertiary bg-surface-2 p-4 active:bg-surface-3">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-usdc">
            <Icon name="bit-coin-line" size={20} />
          </View>
          <View className="flex-1">
            <Text weight="medium" className="text-base">
              Receive crypto
            </Text>
            <Text className="mt-0.5 text-xs text-content-tertiary">USDT, USDC or Bitcoin to your own address</Text>
          </View>
          <Icon name="arrow-right-s-line" size={20} className="text-content-tertiary" />
        </Pressable>
        <Pressable
          onPress={() => router.replace('/withdraw')}
          accessibilityRole="button"
          className="mt-8 flex-row items-center justify-center gap-1.5">
          <Icon name="bank-line" size={14} className="text-primary" />
          <Text className="text-sm text-primary">Withdraw to a bank account</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
