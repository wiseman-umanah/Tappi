import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

function parse(value: string | null) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) } : null;
}

/** "12 April 1990" */
export function formatDate(value: string) {
  const p = parse(value);
  return p ? `${p.d} ${MONTHS[p.m]} ${p.y}` : value;
}

/**
 * A Tappi-styled calendar in a bottom sheet (plain JavaScript: no native module, no rebuild).
 * Tap the month title to jump between years. `max` (YYYY-MM-DD) is the latest date allowed.
 */
export function DatePicker({
  visible,
  value,
  max,
  title,
  onPick,
  onClose,
}: {
  visible: boolean;
  value: string | null;
  max: string;
  title: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const limit = parse(max) ?? { y: new Date().getFullYear(), m: 11, d: 31 };
  const start = parse(value) ?? { y: Math.min(1995, limit.y), m: 0, d: 1 };
  const [view, setView] = useState({ y: start.y, m: start.m });
  const [picked, setPicked] = useState<string | null>(value);
  const [choosingYear, setChoosingYear] = useState(false);

  const beyond = (y: number, m: number, d: number) => iso(y, m, d) > max;
  const canNext = !beyond(view.m === 11 ? view.y + 1 : view.y, (view.m + 1) % 12, 1);
  const move = (by: number) => {
    const total = view.y * 12 + view.m + by;
    setView({ y: Math.floor(total / 12), m: total % 12 });
  };
  const leading = new Date(view.y, view.m, 1).getDay();
  const cells: (number | null)[] = [...Array(leading).fill(null), ...Array.from({ length: daysIn(view.y, view.m) }, (_, i) => i + 1)];
  const years = Array.from({ length: 100 }, (_, i) => limit.y - i);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-overlay" onPress={onClose} accessibilityLabel="Close" />
      <View className="rounded-t-[32px] bg-surface-2 px-6 pt-6" style={{ paddingBottom: insets.bottom + 20 }}>
        <Text weight="bold" className="text-center text-lg">
          {title}
        </Text>

        <View className="mt-5 flex-row items-center justify-between">
          <Pressable onPress={() => move(-1)} hitSlop={10} accessibilityLabel="Previous month" className="h-9 w-9 items-center justify-center rounded-full bg-surface-3">
            <Icon name="arrow-left-s-line" size={18} />
          </Pressable>
          <Pressable onPress={() => setChoosingYear((c) => !c)} accessibilityRole="button" accessibilityHint="Choose a year" className="flex-row items-center gap-1">
            <Text weight="bold" className="text-base">
              {`${MONTHS[view.m]} ${view.y}`}
            </Text>
            <Icon name={choosingYear ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={16} className="text-primary" />
          </Pressable>
          <Pressable
            onPress={() => canNext && move(1)}
            disabled={!canNext}
            hitSlop={10}
            accessibilityLabel="Next month"
            className={cn('h-9 w-9 items-center justify-center rounded-full bg-surface-3', !canNext && 'opacity-30')}>
            <Icon name="arrow-right-s-line" size={18} />
          </Pressable>
        </View>

        {choosingYear ? (
          <ScrollView className="mt-4 h-[280px]" contentContainerClassName="flex-row flex-wrap gap-2 pb-2">
            {years.map((y) => (
              <Pressable
                key={y}
                onPress={() => {
                  setView({ y, m: y === limit.y ? Math.min(view.m, limit.m) : view.m });
                  setChoosingYear(false);
                }}
                className={cn('w-[22%] items-center rounded-full py-2.5', y === view.y ? 'bg-primary' : 'bg-surface-3')}>
                <Text className="text-sm">{String(y)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <View className="mt-4 h-[280px]">
            <View className="flex-row">
              {WEEKDAYS.map((w, i) => (
                <Text key={i} className="flex-1 text-center text-[11px] text-content-tertiary">
                  {w}
                </Text>
              ))}
            </View>
            <View className="mt-2 flex-row flex-wrap">
              {cells.map((d, i) => {
                if (d === null) return <View key={`e${i}`} className="h-11 w-[14.28%]" />;
                const date = iso(view.y, view.m, d);
                const disabled = beyond(view.y, view.m, d);
                const selected = picked === date;
                return (
                  <Pressable
                    key={date}
                    onPress={() => setPicked(date)}
                    disabled={disabled}
                    accessibilityLabel={`${d} ${MONTHS[view.m]} ${view.y}`}
                    accessibilityState={{ selected, disabled }}
                    className="h-11 w-[14.28%] items-center justify-center">
                    <View className={cn('h-9 w-9 items-center justify-center rounded-full', selected && 'bg-primary')}>
                      <Text className={cn('text-sm', disabled && 'text-content-disabled')}>{String(d)}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <Text className="mt-2 text-center text-xs text-content-tertiary">{picked ? formatDate(picked) : 'Pick a day'}</Text>
        <Button label="Done" onPress={() => picked && onPick(picked)} disabled={!picked} className="mt-4" />
      </View>
    </Modal>
  );
}
