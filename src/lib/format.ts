function group(n: number, decimals: number) {
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** ₦482,350.75 — pass decimals: 0 for whole-naira figures like ₦592,319. */
export function naira(amount: number, decimals = 2) {
  return `${amount < 0 ? '-' : ''}₦${group(amount, decimals)}`;
}

/** $25.00 */
export function usd(amount: number, decimals = 2) {
  return `${amount < 0 ? '-' : ''}$${group(amount, decimals)}`;
}

/** Whole-naira amounts drop the kobo (-₦18,450), as in the designs; USDC keeps cents. */
export function money(amount: number, currency: 'NGN' | 'USDC') {
  if (currency === 'USDC') return `${usd(amount)} USDC`;
  return naira(amount, Number.isInteger(amount) ? 0 : 2);
}

const UNITS = [
  { value: 1e12, suffix: 'T' },
  { value: 1e9, suffix: 'B' },
  { value: 1e6, suffix: 'M' },
  { value: 1e3, suffix: 'K' },
];

/**
 * Short form for big headline figures: ₦482.35K, ₦1.04M, ₦6B. Amounts under `from` stay exact.
 * Rounds toward zero so a balance is never shown higher than it is. Keep exact amounts for
 * anything the user confirms (charges, approvals, receipts).
 */
function compact(amount: number, symbol: string, from: number) {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  const unit = UNITS.find((u) => abs >= u.value);
  if (abs < from || !unit) return `${sign}${symbol}${group(amount, 2)}`;
  const scaled = Math.trunc((abs / unit.value) * 100) / 100;
  return `${sign}${symbol}${scaled.toString()}${unit.suffix}`;
}

/** ₦482.35K — exact below ₦100,000. */
export function nairaShort(amount: number, from = 100_000) {
  return compact(amount, '₦', from);
}

/** $1.26M — exact below $100,000. */
export function usdShort(amount: number, from = 100_000) {
  return compact(amount, '$', from);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Today · 06:10", "Yesterday · 07:10", "6 Nov · 04:10" — as in the designs. */
export function when(iso: string) {
  const date = new Date(iso);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(date, today)) return `Today · ${time}`;
  if (same(date, yesterday)) return `Yesterday · ${time}`;
  return `${date.getDate()} ${date.toLocaleString('en-US', { month: 'short' })} · ${time}`;
}

/** Signed amount in its own currency: -₦18,450 / +$25.00 USDC. */
export function signedMoney(amount: number, currency: 'NGN' | 'USDC') {
  const rounded = Math.round(amount * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${money(rounded, currency)}`;
}
