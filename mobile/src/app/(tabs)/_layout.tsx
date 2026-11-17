import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/tab-bar';
import colors from '@/theme/colors';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background.DEFAULT } }}>
      <Tabs.Screen name="index" options={{ title: 'Wallet' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="cards" options={{ title: 'Cards' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
