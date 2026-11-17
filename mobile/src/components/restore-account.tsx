import { useMutation, useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Me } from '@/lib/api-types';
import { tapFeedback } from '@/lib/feedback';
import { useSession } from '@/lib/session';

/** Signed in to an account that is waiting to be deleted: restore it or leave. */
export function RestoreAccount({ me }: { me: Me }) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { signOut } = useSession();
  const deleteAfter = me.account.deleteAfter ? new Date(me.account.deleteAfter) : null;
  const daysLeft = me.account.daysLeft;

  const restore = useMutation({
    mutationFn: () => api<Me>('/me/restore', { body: {} }),
    onSuccess: (data) => {
      tapFeedback('success');
      queryClient.setQueryData(['me'], data);
    },
  });

  return (
    <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <View className="flex-1 items-center justify-center">
        <Avatar gender={me.user.gender} size={96} />
        <Text weight="bold" className="mt-8 text-center text-2xl">
          {`Welcome back${me.user.name ? `, ${me.user.name.split(' ')[0]}` : ''}`}
        </Text>
        <Text className="mt-3 px-2 text-center text-sm leading-5 text-content-tertiary">
          {`You deleted this account. It's still here for ${daysLeft === 1 ? '1 more day' : `${daysLeft ?? 'a few'} more days`}` +
            `${deleteAfter ? ` (until ${deleteAfter.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})` : ''}` +
            ' — restore it to get your balance, history and @' +
            `${me.user.handle ?? 'username'} back.`}
        </Text>
      </View>
      {restore.isError ? <Text className="mb-3 text-center text-sm text-content-negative">{restore.error.message}</Text> : null}
      <Button label="Restore my account" onPress={() => restore.mutate()} loading={restore.isPending} />
      <Button label="Not now" variant="ghost" onPress={signOut} className="mt-2" />
    </View>
  );
}
