import { TextInput, View } from 'react-native';

import { Text } from '@/components/text';
import type { Asset } from '@/lib/api-types';
import colors from '@/theme/colors';

/** Big centred amount field: "₦ 12,500" / "$ 25.50". Keeps only digits and one decimal point. */
export function MoneyInput({ asset, value, onChangeText }: { asset: Asset; value: string; onChangeText: (v: string) => void }) {
  const clean = (text: string) => {
    const digits = text.replace(/[^\d.]/g, '');
    const [int, ...rest] = digits.split('.');
    return rest.length ? `${int}.${rest.join('').slice(0, 2)}` : int;
  };
  return (
    <View className="flex-row items-center justify-center">
      <Text weight="bold" className="text-[34px] text-content-tertiary">
        {asset === 'NGN' ? '₦' : '$'}
      </Text>
      <TextInput
        value={value}
        onChangeText={(text) => onChangeText(clean(text))}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={colors.content.disabled}
        className="min-w-[60px] font-sans-bold text-[40px] text-white"
        style={{ paddingVertical: 4 }}
        accessibilityLabel="Amount"
      />
    </View>
  );
}
