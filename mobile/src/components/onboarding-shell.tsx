import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/text';
import { TopBar } from '@/components/top-bar';

type Props = {
  step?: number;
  steps?: number;
  title: string;
  subtitle?: ReactNode;
  back?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
};

/** Layout for onboarding steps: progress dots, title, content, and a footer pinned above the keyboard. */
export function OnboardingShell({ step, steps = 4, title, subtitle, back = true, footer, children }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="px-5">
        <View className="flex-row items-center justify-between">
          {back ? <TopBar /> : <View className="h-11" />}
          {step ? (
            <View className="flex-row gap-1.5">
              {Array.from({ length: steps }, (_, i) => (
                <View key={i} className={i < step ? 'h-1.5 w-5 rounded-full bg-primary' : 'h-1.5 w-1.5 rounded-full bg-surface-4'} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
      <ScrollView contentContainerClassName="px-5 pb-6" keyboardShouldPersistTaps="handled">
        <Text weight="bold" className="mt-6 text-[26px]">
          {title}
        </Text>
        {subtitle ? <Text className="mt-2 text-sm leading-5 text-content-tertiary">{subtitle}</Text> : null}
        <View className="mt-8">{children}</View>
      </ScrollView>
      {footer ? (
        <View className="px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
