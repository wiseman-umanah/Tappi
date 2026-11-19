import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DatePicker, formatDate } from '@/components/date-picker';
import { Icon } from '@/components/icon';
import { PinSheet } from '@/components/pin-sheet';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import type { UsdCard, UsdCardDetails, UsdCardFees, UsdCardOverview, UsdCardTransaction } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { usd, when } from '@/lib/format';
import { useMe } from '@/lib/queries';
import colors from '@/theme/colors';

const DETAILS_VISIBLE_MS = 30_000;

/** The top-up fee the engine will charge (its prices come from the server, never hard-coded here). */
const topupFee = (fees: UsdCardFees, amount: number) =>
  amount < fees.percentFrom ? fees.topupFlat : Math.ceil(amount * fees.topupPercent) / 100;

function Field({ label, value, onChangeText, placeholder, keyboard }: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboard?: 'default' | 'number-pad' | 'phone-pad';
}) {
  return (
    <View className="mt-4">
      <Text className="mb-1.5 text-xs text-content-tertiary">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.content.disabled}
        keyboardType={keyboard ?? 'default'}
        autoCorrect={false}
        className="rounded-2xl border border-border-disabled bg-surface-1 px-4 py-3.5 font-sans text-base text-white"
      />
    </View>
  );
}

function Chips<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((o) => (
        <Pressable
          key={o.key}
          onPress={() => onChange(o.key)}
          accessibilityRole="radio"
          accessibilityState={{ selected: o.key === value }}
          className={cn('rounded-full border px-3.5 py-2', o.key === value ? 'border-primary bg-primary-900' : 'border-border-tertiary bg-surface-2')}>
          <Text className="text-xs">{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

type Occupation = { code: string; label: string };

/** Bitnob's occupation list; its exact shape isn't documented, so the usual ones are accepted. */
function readOccupations(data: unknown): Occupation[] {
  const rows = Array.isArray(data) ? data : ((data as { occupations?: unknown[]; items?: unknown[] })?.occupations ?? (data as { items?: unknown[] })?.items ?? []);
  return rows.flatMap((row): Occupation[] => {
    if (typeof row === 'string') return [{ code: row, label: row }];
    const r = row as Record<string, unknown>;
    const code = String(r.code ?? r.id ?? r.value ?? '');
    return code ? [{ code, label: String(r.name ?? r.title ?? r.label ?? code) }] : [];
  });
}

/** Cardholders must be 18: the latest birthday allowed, as YYYY-MM-DD. */
function adultBirthday() {
  const d = new Date();
  return `${d.getFullYear() - 18}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EMPLOYMENT = [
  { key: 'employed', label: 'Employed' },
  { key: 'self_employed', label: 'Self-employed' },
  { key: 'student', label: 'Student' },
  { key: 'unemployed', label: 'Unemployed' },
  { key: 'retired', label: 'Retired' },
] as const;

/** Bitnob's card KYC. BVN or NIN is verified instantly; the details must match the ID. */
function KycForm({ reason, onDone }: { reason: string | null; onDone: () => void }) {
  const me = useMe();
  const [first, ...rest] = (me.data?.user.name ?? '').split(' ');
  const [f, setF] = useState({
    firstName: first ?? '',
    lastName: rest.join(' '),
    dateOfBirth: '',
    phoneNumber: '',
    idType: 'bvn' as 'bvn' | 'nin',
    idNumber: '',
    line1: '',
    city: '',
    state: '',
    postalCode: '',
    occupation: '',
    employmentStatus: 'employed' as (typeof EMPLOYMENT)[number]['key'],
    accountPurpose: 'Online payments and subscriptions',
    annualSalary: '',
    expectedMonthlyVolume: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const [picking, setPicking] = useState(false);
  const [pickingDate, setPickingDate] = useState(false);
  const [search, setSearch] = useState('');
  const occupations = useQuery({ queryKey: ['usd-card-occupations'], queryFn: async () => readOccupations(await api('/usd-card/occupations')), staleTime: Infinity });
  const occupationLabel = occupations.data?.find((o) => o.code === f.occupation)?.label;
  const submit = useMutation({ mutationFn: () => api('/usd-card/kyc', { body: f }), onSuccess: onDone });
  const complete =
    f.firstName && f.lastName && /^\d{4}-\d{2}-\d{2}$/.test(f.dateOfBirth) && /^\d{10,11}$/.test(f.phoneNumber) && /^\d{11}$/.test(f.idNumber) &&
    f.line1 && f.city && f.state && f.postalCode && f.occupation && f.annualSalary && f.expectedMonthlyVolume;

  if (picking) {
    const q = search.trim().toLowerCase();
    return (
      <View className="mt-4">
        <Field label="Search occupations" value={search} onChangeText={setSearch} />
        {occupations.isPending ? <ActivityIndicator className="mt-6" color="#FFFFFF" /> : null}
        {(occupations.data ?? [])
          .filter((o) => o.label.toLowerCase().includes(q))
          .slice(0, 50)
          .map((o) => (
            <Pressable key={o.code} onPress={() => (set('occupation')(o.code), setPicking(false))} className="border-b border-border-tertiary py-3">
              <Text className="text-sm">{o.label}</Text>
            </Pressable>
          ))}
      </View>
    );
  }
  return (
    <View>
      <Text className="mt-4 text-sm text-content-secondary">
        We need to verify you before issuing the card. Use the details on your BVN or NIN record.
      </Text>
      {reason ? <Text className="mt-3 text-sm text-content-negative">{`Last attempt was rejected: ${reason}`}</Text> : null}
      <Field label="First name" value={f.firstName} onChangeText={set('firstName')} />
      <Field label="Last name" value={f.lastName} onChangeText={set('lastName')} />
      <Text className="mb-1.5 mt-4 text-xs text-content-tertiary">Date of birth</Text>
      <Pressable
        onPress={() => setPickingDate(true)}
        accessibilityRole="button"
        className="flex-row items-center rounded-2xl border border-border-disabled bg-surface-1 px-4 py-3.5">
        <Text className={cn('flex-1 text-base', !f.dateOfBirth && 'text-content-disabled')}>
          {f.dateOfBirth ? formatDate(f.dateOfBirth) : 'Choose'}
        </Text>
        <Icon name="calendar-line" size={18} className="text-content-tertiary" />
      </Pressable>
      <DatePicker
        visible={pickingDate}
        value={f.dateOfBirth || null}
        max={adultBirthday()}
        title="Date of birth"
        onPick={(date) => (set('dateOfBirth')(date), setPickingDate(false))}
        onClose={() => setPickingDate(false)}
      />
      <Field label="Phone number" value={f.phoneNumber} onChangeText={(v) => set('phoneNumber')(v.replace(/\D/g, ''))} placeholder="08012345678" keyboard="phone-pad" />
      <Text className="mb-1.5 mt-4 text-xs text-content-tertiary">ID</Text>
      <Chips options={[{ key: 'bvn', label: 'BVN' }, { key: 'nin', label: 'NIN' }]} value={f.idType} onChange={(v) => set('idType')(v)} />
      <Field label={`${f.idType.toUpperCase()} (11 digits)`} value={f.idNumber} onChangeText={(v) => set('idNumber')(v.replace(/\D/g, '').slice(0, 11))} keyboard="number-pad" />
      <Field label="Street address" value={f.line1} onChangeText={set('line1')} />
      <Field label="City" value={f.city} onChangeText={set('city')} />
      <Field label="State" value={f.state} onChangeText={set('state')} />
      <Field label="Postal code" value={f.postalCode} onChangeText={set('postalCode')} placeholder="100001" keyboard="number-pad" />
      <Text className="mb-1.5 mt-4 text-xs text-content-tertiary">Occupation</Text>
      <Pressable onPress={() => setPicking(true)} className="flex-row items-center rounded-2xl border border-border-disabled bg-surface-1 px-4 py-3.5">
        <Text className={cn('flex-1 text-base', !occupationLabel && 'text-content-disabled')}>{occupationLabel ?? 'Choose'}</Text>
        <Icon name="arrow-right-s-line" size={18} className="text-content-tertiary" />
      </Pressable>
      <Text className="mb-1.5 mt-4 text-xs text-content-tertiary">Employment</Text>
      <Chips options={[...EMPLOYMENT]} value={f.employmentStatus} onChange={(v) => set('employmentStatus')(v)} />
      <Field label="Yearly income (USD)" value={f.annualSalary} onChangeText={(v) => set('annualSalary')(v.replace(/\D/g, ''))} keyboard="number-pad" />
      <Field label="Expected card spending per month (USD)" value={f.expectedMonthlyVolume} onChangeText={(v) => set('expectedMonthlyVolume')(v.replace(/\D/g, ''))} keyboard="number-pad" />
      <Field label="What you'll use it for" value={f.accountPurpose} onChangeText={set('accountPurpose')} />
      {submit.isError ? <Text className="mt-4 text-sm text-content-negative">{submit.error.message}</Text> : null}
      <Text className="mt-5 text-[11px] text-content-tertiary">By continuing you accept the USD card terms.</Text>
      <Button label="Verify me" onPress={() => submit.mutate()} loading={submit.isPending} disabled={!complete} className="mt-4" />
    </View>
  );
}

/** Amount + which coin pays, then the PIN on the approve screen. */
function MoneyForm({ mode, card, fees, onCancel }: { mode: 'create' | 'fund' | 'withdraw'; card: UsdCard | null; fees: UsdCardFees; onCancel?: () => void }) {
  const me = useMe();
  const [amount, setAmount] = useState('');
  const [payWith, setPayWith] = useState<'USDT' | 'USDC'>(card?.fundingAsset ?? 'USDC');
  const value = Number(amount) || 0;
  const cost = mode === 'withdraw' ? 0 : value + topupFee(fees, value) + (mode === 'create' ? fees.creation : 0);
  const balance = me.data?.wallet?.balances[payWith] ?? 0;
  const tooMuch = mode === 'withdraw' ? value > (card?.balance ?? 0) - 1 : cost > balance;
  const ok = mode === 'withdraw' ? value > 0 && !tooMuch : value >= 2 && value <= 2500 && !tooMuch;
  const next = () =>
    router.push({
      pathname: '/approve',
      params: { action: mode === 'create' ? 'card_create' : mode === 'fund' ? 'card_fund' : 'card_withdraw', amount: String(value), asset: payWith, name: 'your USD card' },
    });
  return (
    <View className="mt-6">
      <MoneyInput asset="USDC" value={amount} onChangeText={setAmount} />
      {mode !== 'withdraw' ? (
        <>
          <Text className="mb-2 mt-6 text-xs text-content-tertiary">Pay with</Text>
          <Chips options={[{ key: 'USDC', label: `USDC · ${usd(me.data?.wallet?.balances.USDC ?? 0)}` }, { key: 'USDT', label: `USDT · ${usd(me.data?.wallet?.balances.USDT ?? 0)}` }]} value={payWith} onChange={setPayWith} />
          <Text className={cn('mt-4 text-xs', tooMuch ? 'text-content-negative' : 'text-content-tertiary')}>
            {value > 0
              ? `${tooMuch ? 'Not enough. ' : ''}You pay ${usd(cost)} ${payWith}: ${usd(value)} on the card${mode === 'create' ? ` + ${usd(fees.creation)} card fee` : ''} + ${usd(topupFee(fees, value))} top-up fee`
              : 'Between $2 and $2,500'}
          </Text>
        </>
      ) : (
        <Text className={cn('mt-3 text-center text-xs', tooMuch ? 'text-content-negative' : 'text-content-tertiary')}>
          {tooMuch ? '$1 has to stay on the card' : `Back to your ${card?.fundingAsset ?? 'USDC'} balance · card has ${usd(card?.balance ?? 0)}`}
        </Text>
      )}
      <Button label="Continue" onPress={next} disabled={!ok} className="mt-6" />
      {onCancel ? (
        <Pressable onPress={onCancel} className="mt-4 self-center">
          <Text className="text-sm text-content-tertiary">Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function CardView({ card, fees, onChanged }: { card: UsdCard; fees: UsdCardFees; onChanged: () => void }) {
  const [details, setDetails] = useState<UsdCardDetails | null>(null);
  const [pinFor, setPinFor] = useState<'details' | 'close' | null>(null);
  const [form, setForm] = useState<'fund' | 'withdraw' | null>(null);
  const transactions = useQuery({ queryKey: ['usd-card-transactions'], queryFn: () => api<{ transactions: UsdCardTransaction[] }>('/usd-card/transactions') });
  useEffect(() => {
    if (!details) return;
    const timer = setTimeout(() => setDetails(null), DETAILS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [details]);
  const reveal = useMutation({ mutationFn: (pin: string) => api<UsdCardDetails>('/usd-card/details', { body: { pin } }), onSuccess: (d) => (setDetails(d), setPinFor(null)) });
  const close = useMutation({ mutationFn: (pin: string) => api('/usd-card/terminate', { body: { pin } }), onSuccess: () => (setPinFor(null), onChanged()) });
  const freeze = useMutation({ mutationFn: (frozen: boolean) => api('/usd-card/freeze', { body: { frozen } }), onSuccess: onChanged });

  if (form) return <MoneyForm mode={form} card={card} fees={fees} onCancel={() => setForm(null)} />;
  return (
    <View>
      <View className="mt-6 h-[200px] justify-between rounded-3xl bg-primary-800 p-5">
        <View className="flex-row items-center justify-between">
          <Text weight="bold" className="text-base">
            USD Virtual
          </Text>
          <Text weight="bold" className="text-lg italic">
            VISA
          </Text>
        </View>
        <Text weight="medium" className="text-xl tracking-widest" selectable={Boolean(details)}>
          {details ? details.number.replace(/(\d{4})(?=\d)/g, '$1 ') : `•••• •••• •••• ${card.last4 ?? '••••'}`}
        </Text>
        <View className="flex-row justify-between">
          <Text className="text-xs">{details ? `${details.expiryMonth}/${details.expiryYear.slice(-2)} · CVV ${details.cvv}` : (card.name ?? '')}</Text>
          <Text weight="bold" className="text-sm">
            {usd(card.balance)}
          </Text>
        </View>
      </View>
      {card.status === 'frozen' ? <Text className="mt-3 text-center text-xs text-content-notice">Frozen: payments are declined until you unfreeze it.</Text> : null}
      <View className="mt-5 flex-row gap-2">
        <Button label="Add money" onPress={() => setForm('fund')} disabled={card.status !== 'active'} className="flex-1" />
        <Button label="Withdraw" variant="secondary" onPress={() => setForm('withdraw')} className="flex-1" />
      </View>
      <Button
        label={details ? 'Hide details' : 'Show card details'}
        variant="secondary"
        icon={details ? 'eye-off-line' : 'eye-line'}
        onPress={() => (details ? setDetails(null) : setPinFor('details'))}
        className="mt-2"
      />
      <View className="mt-5 flex-row items-center rounded-2xl bg-surface-2 px-4 py-3.5">
        <Text className="flex-1 text-sm">Freeze card</Text>
        <Toggle value={card.status === 'frozen'} onValueChange={(v) => freeze.mutate(v)} accessibilityLabel="Freeze card" />
      </View>
      {freeze.isError ? <Text className="mt-2 text-xs text-content-negative">{freeze.error.message}</Text> : null}

      <Text weight="medium" className="mt-6 text-sm">
        Card activity
      </Text>
      {transactions.data?.transactions.length ? (
        transactions.data.transactions.map((t) => (
          <View key={t.id} className="flex-row items-center border-b border-border-tertiary py-3">
            <View className="flex-1">
              <Text className="text-sm" numberOfLines={1}>
                {t.merchant ?? t.type}
              </Text>
              <Text className="text-[10px] text-content-tertiary">{`${t.at ? when(t.at) : ''} · ${t.status}`}</Text>
            </View>
            <Text weight="medium" className="text-sm">
              {usd(t.amount)}
            </Text>
          </View>
        ))
      ) : (
        <Text className="mt-2 text-xs text-content-tertiary">{transactions.isPending ? 'Loading…' : 'No card activity yet.'}</Text>
      )}

      <Pressable onPress={() => setPinFor('close')} className="mt-8 self-center">
        <Text className="text-sm text-content-negative">Close card</Text>
      </Pressable>
      <Text className="mt-1 text-center text-[10px] text-content-tertiary">Its balance comes back to your {card.fundingAsset}. Not possible in the first 24 hours.</Text>

      <PinSheet
        visible={pinFor !== null}
        title={pinFor === 'close' ? 'Close your USD card' : 'Show card details'}
        detail={pinFor === 'close' ? 'This ends the card for good.' : 'Shown for 30 seconds. Never share them.'}
        busy={reveal.isPending || close.isPending}
        error={(pinFor === 'close' ? close.error : reveal.error)?.message ?? null}
        onPin={(pin) => (pinFor === 'close' ? close.mutate(pin) : reveal.mutate(pin))}
        onClose={() => setPinFor(null)}
      />
    </View>
  );
}

/** The Bitnob USD virtual Visa card: verify, create, top up, spend online, withdraw. */
export default function UsdCardScreen() {
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ['usd-card'], queryFn: () => api<UsdCardOverview>('/usd-card'), refetchInterval: (q) => (q.state.data && (['initiated', 'pending'].includes(q.state.data.kyc.status) || q.state.data.card?.status === 'pending') ? 5000 : false) });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['usd-card'] });
    void client.invalidateQueries({ queryKey: ['usd-card-transactions'] });
    void client.invalidateQueries({ queryKey: ['me'] });
  };
  const o = overview.data;

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <TopBar title="USD card" />
      </View>
      <ScrollView contentContainerClassName="px-5" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        {!o ? (
          overview.isError ? (
            <Text className="mt-10 text-center text-sm text-content-negative">{overview.error.message}</Text>
          ) : (
            <ActivityIndicator className="mt-16" color="#FFFFFF" />
          )
        ) : o.card && o.card.status !== 'pending' ? (
          <CardView card={o.card} fees={o.fees} onChanged={refresh} />
        ) : o.card ? (
          <Text className="mt-16 text-center text-sm text-content-secondary">Your card is being made. This takes a moment.</Text>
        ) : o.kyc.status === 'approved' ? (
          <View>
            <Text className="mt-4 text-sm text-content-secondary">
              A USD Visa card for online payments, topped up from your USDT or USDC. You&apos;re verified: choose how much to put on it.
            </Text>
            <MoneyForm mode="create" card={null} fees={o.fees} />
          </View>
        ) : o.kyc.status === 'pending' || o.kyc.status === 'initiated' ? (
          <Text className="mt-16 text-center text-sm text-content-secondary">We&apos;re checking your details. This usually takes a few minutes.</Text>
        ) : (
          <KycForm reason={o.kyc.status === 'rejected' ? o.kyc.reason : null} onDone={refresh} />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
