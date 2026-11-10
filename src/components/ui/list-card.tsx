import { Children, Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/cn';

/** Rounded surface that draws hairline dividers between its rows. */
export function ListCard({ children, className }: { children: ReactNode; className?: string }) {
  const rows = Children.toArray(children);
  return (
    <View className={cn('overflow-hidden rounded-xl bg-surface-2', className)}>
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 ? <View className="h-px bg-border-tertiary" /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}
