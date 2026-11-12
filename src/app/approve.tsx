import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeBoxes } from '@/components/code-boxes';
import { TapResult } from '@/components/motion/tap-result';
import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Asset, Me, Prepared } from '@/lib/api-types';
import { tapFeedback } from '@/lib/feedback';
import { naira, usd } from '@/lib/format';
import { openExternal } from '@/lib/links';
import { goBack, goHome } from '@/lib/nav';
import { signAndSubmit } from '@/lib/pollar';
import { useRefreshMoney } from '@/lib/queries';
import { useSession } from '@/lib/session';

// Design: design/screens/11-approve-request-pin.png
// Every money-moving action ends here: the PIN goes to the server, which checks it and builds the
// transaction; this phone signs it through Pollar (Pollar holds the wallet, not Tappi) and the
// server submits it. Account actions (disable, enable, delete) reuse the PIN screen.
type Params = {
  action: 'send' | 'swap' | 'pay' | 'refund' | 'settle' | 'disable' | 'enable' | 'delete';
  amount: string;
  asset?: Asset;
  to?: string;
  name?: string;
  from?: Asset;
  /** pay: the currency the merchant charged in (`asset` is the balance it's paid from). */
  chargeAsset?: Asset;
  receive?: string;
  code?: string;
  channel?: string;
  id?: string;
  /** '1' when opened from Tappi AI: go back to the chat when done. */
  back?: string;
};

const PIN_LENGTH = 4;
const fmt = (asset: Asset | undefined, n: number) => (asset === 'USDC' ? `${usd(n)} USDC` : naira(n));

function describe(p: Params) {
  const amount = Number(p.amount);
  switch (p.action) {
    case 'send':
      return { verb: 'send', amount: fmt(p.asset, amount), rest: `to ${p.name}`, done: `${fmt(p.asset, amount)} sent to ${p.name}`, title: 'Money sent' };
    case 'swap': {
      const to: Asset = p.from === 'NGN' ? 'USDC' : 'NGN';
      const get = fmt(to, Number(p.receive));
      return { verb: 'swap', amount: fmt(p.from, amount), rest: `for about ${get}`, done: `You got about ${get}`, title: 'Swap complete' };
    }
    case 'pay': {
      const charged = p.chargeAsset ?? 'NGN';
      const from = p.asset ?? charged;
      return {
        verb: 'pay',
        amount: fmt(charged, amount),
        rest: `to ${p.name}${from !== charged ? (from === 'USDC' ? ' from your USDC' : ' from your naira') : ''}`,
        done: `${fmt(charged, amount)} paid to ${p.name}`,
        title: 'Payment successful',
      };
    }
    case 'refund':
      return {
        verb: 'refund',
        amount: fmt(p.asset, amount),
        rest: `to ${p.name}`,
        done: `${fmt(p.asset, amount)} refunded to ${p.name}`,
        title: 'Refund sent',
      };
    case 'settle':
      return { verb: 'settle', amount: naira(amount), rest: 'to your bank', done: `${naira(amount)} is on its way to your bank`, title: 'Settled' };
    case 'disable':
      return { verb: 'disable', amount: 'your account', rest: '— no money can come in', done: 'Nobody can send you money until you turn it back on.', title: 'Account disabled' };
    case 'enable':
      return { verb: 'turn on', amount: 'payments', rest: 'to your account', done: 'People can send you money again.', title: 'Account enabled' };
    case 'delete':
      return { verb: 'delete', amount: 'your Tappi account', rest: '', done: 'Changed your mind? Sign in within 30 days to restore it.', title: 'Account deleted' };
  }
}

type Outcome = { tx?: string } & Partial<Me>;

/** PIN checked and transaction built by the server → signed here through Pollar → submitted. */
const signed = async (path: string, body: Record<string, unknown>) =>
  signAndSubmit<{ tx: string }>(await api<Prepared>(path, { body }));

function request(p: Params, pin: string): Promise<Outcome> {
  switch (p.action) {
    case 'send':
      return signed('/send', { to: p.to, asset: p.asset, amount: Number(p.amount), pin });
    case 'swap':
      return signed('/swap', { from: p.from, amount: Number(p.amount), pin });
    case 'pay':
      return signed(`/requests/${p.code}/pay`, { pin, asset: p.asset, channel: p.channel });
    case 'refund':
      return signed(`/requests/${p.id}/refund`, { pin });
    case 'settle':
      return signed('/merchant/settle', { pin });
    case 'disable':
    case 'enable':
      return api<Me>('/me/receiving', { body: { enabled: p.action === 'enable', pin } });
    case 'delete':
      return api('/me/delete', { body: { pin } });
  }
}

export default function ApproveScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  const refresh = useRefreshMoney();
  const queryClient = useQueryClient();
  const { signOut } = useSession();
  const [pin, setPin] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const text = describe(params);
  const merchantSide = params.action === 'refund' || params.action === 'settle';
  const accountAction = params.action === 'disable' || params.action === 'enable' || params.action === 'delete';

  const approve = useMutation({
    mutationFn: (value: string) => request(params, value),
    onSuccess: (data) => {
      tapFeedback('success');
      // A deleted account's sessions are gone; refetching now would sign out before "Done".
      if (params.action === 'delete') return;
      if (params.action === 'disable' || params.action === 'enable') queryClient.setQueryData(['me'], data);
      else refresh();
    },
    onError: () => {
      tapFeedback('declined');
      setErrorKey((k) => k + 1);
      setPin('');
    },
  });

  const onChange = (value: string) => {
    setPin(value);
    if (value.length === PIN_LENGTH) approve.mutate(value);
  };

  const done = () => {
    if (params.action === 'delete') return signOut();
    return merchantSide || accountAction || params.back === '1' ? goBack() : goHome();
  };

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      {approve.isSuccess ? (
        <View className="flex-1 items-center justify-center">
          <TapResult outcome="success" title={text.title} detail={text.done} />
          {approve.data.tx ? (
            <Text
              weight="medium"
              className="mt-6 text-sm text-primary"
              onPress={() => approve.data.tx && openExternal(approve.data.tx)}
              accessibilityRole="link">
              View on Stellar explorer
            </Text>
          ) : null}
          <Button label="Done" onPress={done} className="mt-10 self-stretch" />
        </View>
      ) : (
        <>
          <TopBar close />
          <View className="mt-6">
            <Text weight="bold" className="text-[22px]">
              Approve Request
            </Text>
            <Text className="mt-1 text-xs">
              {`You're about to ${text.verb}  `}
              <Text weight="bold" className="text-xs text-primary">
                {text.amount}
              </Text>
              {text.rest ? `  ${text.rest}` : ''}
            </Text>

            <View className="mt-12">
              <CodeBoxes
                length={PIN_LENGTH}
                value={pin}
                onChangeText={onChange}
                secure
                autoFocus
                editable={!approve.isPending}
                errorKey={errorKey}
                accessibilityLabel="Transaction PIN"
              />
            </View>

            <Text className="mt-12 text-xs">
              {approve.isPending ? (accountAction ? 'Saving…' : 'Signing with your wallet and confirming on Stellar…') : 'Input your transaction pin'}
            </Text>
            {approve.isError ? <Text className="mt-2 text-sm text-content-negative">{approve.error.message}</Text> : null}
          </View>
        </>
      )}
    </View>
  );
}
