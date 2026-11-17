import type { IconName } from '@/components/icon';

/** Categories a merchant can file a charge under (Terminal) and how Activity shows them. */
export const CHARGE_TAGS = ['Groceries', 'Food', 'Tech', 'Other'] as const;

const ICONS: Record<string, IconName> = {
  Groceries: 'shopping-basket-2-line',
  Food: 'restaurant-2-line',
  Tech: 'computer-line',
  Transfer: 'arrow-left-right-line',
  Deposit: 'download-2-line',
  Swap: 'exchange-line',
  Settlement: 'bank-line',
  Other: 'shopping-bag-3-line',
};

export const tagIcon = (tag: string): IconName => ICONS[tag] ?? ICONS.Other;

export const CHANNEL_LABEL: Record<string, string> = {
  nfc: 'NFC tap',
  qr: 'QR',
  code: 'Code',
  send: 'Transfer',
  nearby: 'Nearby',
  card: 'Bank card',
  tappi_card: 'Tappi card',
};
