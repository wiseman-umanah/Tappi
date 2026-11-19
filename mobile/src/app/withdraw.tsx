import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import type { Bank } from '@/lib/api-types';
import { naira } from '@/lib/format';
import { useBanks, useMe, useResolvedAccount } from '@/lib/queries';
import colors from '@/theme/colors';

const MIN_WITHDRAWAL = 100;

/** Picks the bank: a searchable list (Nigeria has hundreds of banks and fintechs). */
function BankPicker({ onPick, onClose }: { onPick: (bank: Bank) => void; onClose: () => void }) {
  const banks = useBanks();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = (banks.data ?? []).filter((b) => b.name.toLowerCase().includes(q));
  return (
    <View className="flex-1">
      <View className="mt-4 flex-row items-center gap-2 rounded-2xl border border-border-disabled bg-surface-1 px-4">
        <Icon name="search-line" size={16} className="text-content-tertiary" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search banks"
          placeholderTextColor={colors.content.disabled}
          autoFocus
          autoCorrect={false}
          className="flex-1 py-3.5 font-sans text-base text-white"
        />
        <Pressable onPress={onClose} accessibilityLabel="Close bank list" hitSlop={8}>
          <Icon name="close-line" size={18} className="text-content-tertiary" />
        </Pressable>
      </View>
      {banks.isPending ? (
        <ActivityIndicator className="mt-10" color="#FFFFFF" />
      ) : banks.isError ? (
        <Text className="mt-6 text-sm text-content-negative">{banks.error.message}</Text>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(b) => b.uuid}
          keyboardShouldPersistTaps="handled"
          className="mt-2"
          renderItem={({ item }) => (
            <Pressable onPress={() => onPick(item)} className="border-b border-border-tertiary py-3.5 active:bg-surface-2">
              <Text className="text-sm">{item.name}</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text className="mt-6 text-center text-sm text-content-tertiary">No bank by that name</Text>}
        />
      )}
    </View>
  );
}

/** Naira to any Nigerian bank account (Paga). The holder's name is checked before the PIN. */
export default function WithdrawScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  // The merchant dashboard opens this with its naira balance filled in.
  const params = useLocalSearchParams<{ amount?: string }>();
  const [amount, setAmount] = useState(params.amount ?? '');
  const [bank, setBank] = useState<Bank | null>(null);
  const [picking, setPicking] = useState(false);
  const [accountNumber, setAccountNumber] = useState('');
  const resolved = useResolvedAccount(bank?.uuid ?? null, accountNumber);
  const balance = me.data?.wallet?.balances.NGN ?? 0;
  const value = Number(amount) || 0;
  const tooMuch = value > balance;
  const tooLittle = value > 0 && value < MIN_WITHDRAWAL;
  const accountName = resolved.data?.accountName ?? null;
  const canContinue = Boolean(bank) && resolved.isSuccess && value >= MIN_WITHDRAWAL && !tooMuch;

  const next = () => {
    if (!bank || !resolved.isSuccess) return;
    router.push({
      pathname: '/approve',
      params: {
        action: 'withdraw',
        amount: String(value),
        asset: 'NGN',
        bankUuid: bank.uuid,
        accountNumber,
        name: accountName ?? `${bank.name} •••• ${accountNumber.slice(-4)}`,
      },
    });
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="Withdraw" />
      </View>
      {picking ? (
        <View className="flex-1 px-5">
          <BankPicker
            onPick={(b) => {
              setBank(b);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        </View>
      ) : (
        <>
          <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
            <View className="mt-8">
              <MoneyInput asset="NGN" value={amount} onChangeText={setAmount} />
              <Text
                className={
                  tooMuch || tooLittle ? 'mt-2 text-center text-xs text-content-negative' : 'mt-2 text-center text-xs text-content-tertiary'
                }>
                {tooMuch ? 'More than your balance' : tooLittle ? `At least ${naira(MIN_WITHDRAWAL, 0)}` : `Balance ${naira(balance)}`}
              </Text>
            </View>

            <Text className="mb-2 mt-8 text-xs text-content-tertiary">Bank</Text>
            <Pressable
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              className="flex-row items-center rounded-2xl border border-border-disabled bg-surface-1 px-4 py-4">
              <Text className={bank ? 'flex-1 text-base' : 'flex-1 text-base text-content-disabled'}>{bank?.name ?? 'Choose a bank'}</Text>
              <Icon name="arrow-right-s-line" size={20} className="text-content-tertiary" />
            </Pressable>

            <Text className="mb-2 mt-5 text-xs text-content-tertiary">Account number</Text>
            <TextInput
              value={accountNumber}
              onChangeText={(t) => setAccountNumber(t.replace(/\D/g, '').slice(0, 10))}
              placeholder="10 digits"
              placeholderTextColor={colors.content.disabled}
              keyboardType="number-pad"
              className="rounded-2xl border border-border-disabled bg-surface-1 px-4 py-4 font-sans text-base tracking-widest text-white"
            />
            <View className="mt-3 min-h-[24px]">
              {resolved.isFetching ? (
                <Text className="text-xs text-content-tertiary">Checking the account…</Text>
              ) : resolved.isSuccess ? (
                <View className="flex-row items-center gap-1.5">
                  <Icon name="check-line" size={14} className="text-content-positive" />
                  <Text weight="medium" className="text-sm">
                    {accountName ?? 'Account found'}
                  </Text>
                </View>
              ) : resolved.isError ? (
                <Text className="text-xs text-content-negative">{resolved.error.message}</Text>
              ) : null}
            </View>
          </ScrollView>
          <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            <Button label="Continue" onPress={next} disabled={!canContinue} />
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}
