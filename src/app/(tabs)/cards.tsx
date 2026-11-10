import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/screen';
import { TappiLogo } from '@/components/tappi-logo';
import { Text } from '@/components/text';
import { Badge } from '@/components/ui/badge';
import { ListCard } from '@/components/ui/list-card';
import { Toggle } from '@/components/ui/toggle';
import { Icon } from '@/components/icon';
import { linkedCards, physicalCard } from '@/lib/mock-data';
import { useMe } from '@/lib/queries';

// Design: design/screens/07-cards.png
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// Iridescent foil approximated with two crossed gradients.
const FOIL = ['#FF8F8F', '#FFB86B', '#FFE8A3', '#7FE7D9', '#5EA8FF', '#A98BFF', '#FF8FCB'] as const;

function HoloCard() {
  const me = useMe();
  return (
    <View className="overflow-hidden rounded-3xl">
      <View style={{ aspectRatio: 1.9 }}>
        <LinearGradient colors={FOIL} start={{ x: 0, y: 0.2 }} end={{ x: 1, y: 0.8 }} style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,255,255,0.35)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0.25)']}
          start={{ x: 1, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View className="absolute right-4 top-4 h-9 w-9 items-center justify-center rounded-full bg-black">
          <TappiLogo size={18} />
        </View>
        <View className="flex-1 justify-end px-6 pb-5">
          <Text
            weight="bold"
            numberOfLines={1}
            adjustsFontSizeToFit
            className="text-lg text-black"
            style={{ fontFamily: MONO, letterSpacing: 0.5 }}>
            {physicalCard.number}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center justify-between bg-card px-6 py-5">
        <Text weight="bold" className="text-sm">
          {me.data?.user.name ?? physicalCard.holder}
        </Text>
        <Text className="text-sm">
          Exp{' '}
          <Text weight="bold" className="text-sm" style={{ fontFamily: MONO }}>
            {physicalCard.expiry}
          </Text>
        </Text>
      </View>
    </View>
  );
}

export default function CardsScreen() {
  const [primaryId, setPrimaryId] = useState(linkedCards[0].id);
  const [unlock, setUnlock] = useState(true);
  const [sound, setSound] = useState(true);

  return (
    <Screen title="Cards" subtitle="Linked cards and tap preferences" withTabBar>
      <View className="mb-10 mt-2 px-5">
        <HoloCard />
      </View>

      <ListCard>
        {linkedCards.map((card) => {
          const isPrimary = card.id === primaryId;
          return (
            <View key={card.id} className="flex-row items-center gap-3 px-4 py-3">
              <View className="h-7 w-7 items-center justify-center rounded-md bg-primary-600">
                <Icon name="bank-card-line" size={14} />
              </View>
              <View className="flex-1">
                <Text weight="medium" className="text-sm">
                  {card.name}
                </Text>
                <Text className="mt-0.5 text-[10px] text-content-tertiary">
                  {`${card.network} •••• ${card.last4}`}
                </Text>
              </View>
              {isPrimary ? (
                <Badge label="Primary" tone="positive" />
              ) : (
                <Pressable onPress={() => setPrimaryId(card.id)} hitSlop={6}>
                  <Badge label="Make Primary" tone="neutral" className="border border-border-secondary" />
                </Pressable>
              )}
            </View>
          );
        })}
      </ListCard>

      <ListCard className="mt-6">
        <View className="flex-row items-center px-4 py-3">
          <View className="flex-1">
            <Text weight="medium" className="text-sm">
              Unlock before tapping
            </Text>
            <Text className="mt-0.5 text-[10px] text-content-tertiary">Face ID or PIN for every payment</Text>
          </View>
          <Toggle value={unlock} onValueChange={setUnlock} accessibilityLabel="Unlock before tapping" />
        </View>
        <View className="flex-row items-center px-4 py-3">
          <View className="flex-1">
            <Text weight="medium" className="text-sm">
              Tap sound & haptics
            </Text>
            <Text className="mt-0.5 text-[10px] text-content-tertiary">Confirm each payment with a chime</Text>
          </View>
          <Toggle value={sound} onValueChange={setSound} accessibilityLabel="Tap sound and haptics" />
        </View>
      </ListCard>
    </Screen>
  );
}
