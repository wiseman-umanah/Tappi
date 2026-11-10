import { Image } from 'expo-image';

import type { Gender } from '@/lib/api-types';

const AVATARS = {
  female: require('../../assets/images/avatars/avatar-female.png'),
  male: require('../../assets/images/avatars/avatar-male.png'),
};

export function Avatar({ gender, size = 40 }: { gender: Gender | null | undefined; size?: number }) {
  return (
    <Image
      source={AVATARS[gender ?? 'female']}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      accessibilityIgnoresInvertColors
    />
  );
}
