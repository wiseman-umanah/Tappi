import type { ReactNode } from 'react';
import { View } from 'react-native';

import colors from '@/theme/colors';

/** In a browser, the app keeps a phone's width, centred, so it looks the same on a laptop as on a
 * phone. Narrow screens (phones) still get the full width. */
export function WebFrame({ children }: { children: ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: '#0b0b0c' }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 440,
          overflow: 'hidden',
          backgroundColor: colors.background.DEFAULT,
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: colors.border.DEFAULT,
        }}
      >
        {children}
      </View>
    </View>
  );
}
