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
import { api, idempotencyKey } from '@/lib/api';
import type { AnyAsset, Asset, Me, SwapResult, Withdrawal } from '@/lib/api-types';
import { tapFeedback } from '@/lib/feedback';
import { money, naira, usd } from '@/lib/format';
import { goBack, goHome } from '@/lib/nav';
import { useRefreshMoney } from '@/lib/queries';
import { useSession } from '@/lib/session';

// Design: design/screens/11-approve-request-pin.png
// Every money-moving action ends here: the PIN goes to the server with the request, and the
// server checks it before moving anything. Account actions (disable, enable, delete) reuse it.
type Params = {
  action: 'send' | 'pay' | 'refund' | 'withdraw' | 'crypto' | 'swap' | 'card_create' | 'card_fund' | 'card_withdraw' | 'disable' | 'enable' | 'delete';
  amount: string;
  /** send: any balance (Tappi AI can prepare USDT or BTC sends); pay and refund: NGN or USDC. */
  asset?: AnyAsset;
  to?: string;
  name?: string;
  /** pay: the currency the merchant charged in (`asset` is the balance it's paid from). */
  chargeAsset?: Asset;
  code?: string;
  channel?: string;
  id?: string;
  /** withdraw: where the naira goes. */
  bankUuid?: string;
  accountNumber?: string;
  /** swap: the stored quote, and what it gives. */
  quoteId?: string;
  toAsset?: AnyAsset;
  receive?: string;
  /** crypto: where the coins go. */
  chain?: string;
  address?: string;
  /** '1' when opened from Tappi AI: go back to the chat when done. */
  back?: string;
};

const PIN_LENGTH = 4;
const fmt = (asset: AnyAsset | undefined, n: number) => money(n, asset ?? 'NGN');

function describe(p: Params) {
  const amount = Number(p.amount);
  switch (p.action) {
    case 'send':
      return { verb: 'send', amount: fmt(p.asset, amount), rest: `to ${p.name}`, done: `${fmt(p.asset, amount)} sent to ${p.name}`, title: 'Money sent' };
    case 'pay': {
      // A charge is paid from the balance in its own currency.
      const charged = p.chargeAsset ?? 'NGN';
      return {
        verb: 'pay',
        amount: fmt(charged, amount),
        rest: `to ${p.name}`,
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
    case 'withdraw':
      return {
        verb: 'withdraw',
        amount: naira(amount),
        rest: `to ${p.name}`,
        done: `${naira(amount)} sent to ${p.name}`,
        title: 'Withdrawal sent',
      };
    case 'card_create':
      return { verb: 'put', amount: usd(amount), rest: `on a new USD card (paid in ${p.asset})`, done: 'Your USD card is being made.', title: 'Card requested' };
    case 'card_fund':
      return { verb: 'add', amount: usd(amount), rest: `to your USD card (paid in ${p.asset})`, done: `${usd(amount)} added to your card`, title: 'Card topped up' };
    case 'card_withdraw':
      return { verb: 'move', amount: usd(amount), rest: 'from your USD card to your balance', done: `${usd(amount)} is back in your balance`, title: 'Moved off your card' };
    case 'swap': {
      const get = fmt(p.toAsset, Number(p.receive));
      return { verb: 'swap', amount: fmt(p.asset, amount), rest: `for ${get}`, done: `You got ${get}`, title: 'Swap complete' };
    }
    case 'crypto':
      return {
        verb: 'send',
        amount: fmt(p.asset, amount),
        rest: `to ${p.name}`,
        done: `${fmt(p.asset, amount)} sent to ${p.name}`,
        title: 'Crypto sent',
      };
    case 'disable':
      return { verb: 'disable', amount: 'your account', rest: '— no money can come in', done: 'Nobody can send you money until you turn it back on.', title: 'Account disabled' };
    case 'enable':
      return { verb: 'turn on', amount: 'payments', rest: 'to your account', done: 'People can send you money again.', title: 'Account enabled' };
    case 'delete':
      return { verb: 'delete', amount: 'your Tappi account', rest: '', done: 'Changed your mind? Sign in within 30 days to restore it.', title: 'Account deleted' };
  }
}

type Outcome = { reference?: string; status?: Withdrawal['status'] } & Partial<Me>;

/** `key` is the same for every try on this screen, so a retried send or settlement happens once. */
function request(p: Params, pin: string, key: string): Promise<Outcome> {
  const headers = { 'Idempotency-Key': key };
  switch (p.action) {
    case 'send':
      return api('/send', { body: { to: p.to, asset: p.asset, amount: p.amount, pin }, headers });
    case 'pay':
      return api(`/requests/${p.code}/pay`, { body: { pin, channel: p.channel } });
    case 'refund':
      return api(`/requests/${p.id}/refund`, { body: { pin } });
    case 'card_create':
    case 'card_fund':
    case 'card_withdraw': {
      const path = { card_create: '/usd-card', card_fund: '/usd-card/fund', card_withdraw: '/usd-card/withdraw' }[p.action];
      return api<{ status: string; error?: string | null }>(path, { body: { amount: p.amount, payWith: p.asset, pin }, headers }).then((r) => {
        if (r.status === 'failed') throw new Error(r.error ?? "It wasn't accepted. Your money is back in your balance.");
        return { status: r.status === 'pending' && p.action !== 'card_create' ? 'pending' : 'succeeded' } as Outcome;
      });
    }
    case 'swap':
      // Only the quote id: the amounts are the ones Bitnob quoted, kept on the server.
      return api<SwapResult>('/swap', { body: { quoteId: p.quoteId, pin } }).then((r) => {
        if (r.status === 'failed') throw new Error(r.error ?? "The swap didn't go through.");
        return r;
      });
    case 'crypto':
      return api<Withdrawal>('/crypto/send', {
        body: { asset: p.asset, chain: p.chain, address: p.address, amount: p.amount, pin },
        headers,
      }).then((w) => {
        if (w.status === 'failed') throw new Error(w.error ?? 'It couldn\'t be sent.');
        return w;
      });
    case 'withdraw':
      return api<Withdrawal>('/withdraw', {
        body: { bankUuid: p.bankUuid, accountNumber: p.accountNumber, accountName: p.name, amount: p.amount, pin },
        headers,
      }).then((w) => {
        // Refused straight away by the bank: the money is already back in the balance.
        if (w.status === 'failed') throw new Error(w.error ?? 'The bank refused the transfer.');
        return w;
      });
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
  const [key] = useState(idempotencyKey);
  const [errorKey, setErrorKey] = useState(0);
  const text = describe(params);
  const merchantSide = params.action === 'refund' || params.action === 'withdraw' || params.action === 'crypto' || params.action.startsWith('card_');
  const accountAction = params.action === 'disable' || params.action === 'enable' || params.action === 'delete';

  const approve = useMutation({
    mutationFn: (value: string) => request(params, value, key),
    onSuccess: (data) => {
      tapFeedback('success');
      // A deleted account's sessions are gone; refetching now would sign out before "Done".
      if (params.action === 'delete') return;
      if (params.action === 'disable' || params.action === 'enable') queryClient.setQueryData(['me'], data);
      else refresh();
      if (params.action.startsWith('card_')) void queryClient.invalidateQueries({ queryKey: ['usd-card'] });
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
          {approve.data.status === 'pending' ? (
            <TapResult
              outcome="success"
              title={params.action === 'swap' ? 'Swap processing' : params.action === 'crypto' ? 'Sending' : params.action.startsWith('card_') ? 'Processing' : 'Withdrawal on its way'}
              detail={
                params.action === 'swap'
                  ? `${text.amount} ${text.rest}. It shows in your balance in a moment.`
                  : `${text.amount} to ${params.name}. It shows in your activity when ${params.action === 'crypto' ? 'the network' : 'the bank'} confirms.`
              }
            />
          ) : (
            <TapResult outcome="success" title={text.title} detail={text.done} />
          )}
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
              {approve.isPending ? (accountAction ? 'Saving…' : 'Confirming…') : 'Input your transaction pin'}
            </Text>
            {approve.isError ? <Text className="mt-2 text-sm text-content-negative">{approve.error.message}</Text> : null}
          </View>
        </>
      )}
    </View>
  );
}
