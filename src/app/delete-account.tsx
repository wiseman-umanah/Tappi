import { router } from 'expo-router';
import { View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { OnboardingShell } from '@/components/onboarding-shell';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { naira, usd } from '@/lib/format';
import { useMe } from '@/lib/queries';

function Point({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View className="flex-row gap-3 py-3">
      <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-2">
        <Icon name={icon} size={16} className="text-content-secondary" />
      </View>
      <View className="flex-1">
        <Text weight="medium" className="text-sm">
          {title}
        </Text>
        <Text className="mt-1 text-xs leading-5 text-content-tertiary">{body}</Text>
      </View>
    </View>
  );
}

/** Profile → Delete account: what happens and when, before the PIN step in /approve. */
export default function DeleteAccountScreen() {
  const me = useMe();
  const days = me.data?.account.restoreDays ?? 30;
  const ngn = me.data?.wallet?.balances.NGN ?? 0;
  const usdc = me.data?.wallet?.balances.USDC ?? 0;
  const hasMoney = ngn >= 0.01 || usdc >= 0.01;

  return (
    <OnboardingShell
      title="Delete your account?"
      subtitle="Here's exactly what happens."
      footer={
        <View className="gap-3">
          <Button
            label="Delete my account"
            variant="danger"
            onPress={() => router.push({ pathname: '/approve', params: { action: 'delete', amount: '0' } })}
          />
          <Button label="Keep my account" variant="ghost" onPress={() => router.back()} />
        </View>
      }>
      {hasMoney ? (
        <View className="mb-3 flex-row gap-3 rounded-2xl bg-background-notice-subtle p-4">
          <Icon name="error-warning-line" size={18} className="text-content-notice" />
          <Text className="flex-1 text-xs leading-5">
            {`You still have ${naira(ngn)} and ${usd(usdc)} USDC. It stays in your Pollar wallet, which is yours: deleting Tappi doesn't touch it, but Tappi can't show it to you after ${days} days. Send it somewhere first if you'd rather.`}
          </Text>
        </View>
      ) : null}
      <Point
        icon="logout-box-r-line"
        title="You're signed out everywhere"
        body="Your @username stops receiving money and any open charges on your Terminal are cancelled."
      />
      <Point
        icon="restart-line"
        title={`${days} days to change your mind`}
        body={`Sign in with ${me.data?.user.email ?? 'your email'} within ${days} days to restore everything: balance, history and @username.`}
      />
      <Point
        icon="delete-bin-line"
        title="Then your details are erased"
        body="Your name, email, username, avatar and PIN are deleted. The email can sign up again later as a brand-new account."
      />
      <Point
        icon="file-list-3-line"
        title="Transaction records are kept for 5 years"
        body="Nigerian financial regulations require us to keep payment records for 5 years after an account closes. They're stored without your personal details, then deleted."
      />
    </OnboardingShell>
  );
}
