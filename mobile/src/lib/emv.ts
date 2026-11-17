import type { CardBrand } from '@/lib/api-types';

/**
 * Just enough EMV contactless to tell which card was tapped: select the card's directory (PPSE)
 * and read the payment application IDs it lists. No card number, expiry or cryptogram is read,
 * so nothing here is cardholder data.
 */
type Transceive = (apdu: number[]) => Promise<number[]>;

const hex = (s: string) => s.match(/../g)!.map((b) => parseInt(b, 16));
const toHex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

const selectAid = (aid: number[]) => [0x00, 0xa4, 0x04, 0x00, aid.length, ...aid, 0x00];
/** "2PAY.SYS.DDF01", the contactless payment directory every EMV card answers. */
const PPSE = selectAid([...'2PAY.SYS.DDF01'].map((c) => c.charCodeAt(0)));

// Registered application ID prefixes (RIDs and a few full AIDs). Longest match wins.
const BRANDS: [string, CardBrand][] = [
  ['A0000003710001', 'Verve'],
  ['A000000371', 'Verve'],
  ['A000000003', 'Visa'],
  ['A000000004', 'Mastercard'],
  ['A000000005', 'Mastercard'], // Maestro
  ['A000000025', 'American Express'],
  ['A000000152', 'Discover'],
  ['A000000324', 'Discover'],
  ['A000000333', 'UnionPay'],
  ['A000000065', 'JCB'],
];

/** Cards that skip the directory still answer a direct select of their own application. */
const FALLBACK_AIDS = ['A0000000031010', 'A0000000041010', 'A0000003710001', 'A00000002501'];

export function brandOf(aid: string): CardBrand {
  const match = BRANDS.filter(([prefix]) => aid.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0];
  return match?.[1] ?? 'Card';
}

type Tlv = { tag: string; value: number[] };

/** BER-TLV, recursing into constructed tags (bit 6 of the first tag byte). */
export function parseTlv(bytes: number[], out: Tlv[] = []): Tlv[] {
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x00 || bytes[i] === 0xff) {
      i++;
      continue;
    }
    const start = i;
    if ((bytes[i++] & 0x1f) === 0x1f) while (i < bytes.length && bytes[i++] & 0x80);
    const tagBytes = bytes.slice(start, i);
    if (i >= bytes.length) break;
    let length = bytes[i++];
    if (length & 0x80) {
      const n = length & 0x7f;
      length = 0;
      for (let k = 0; k < n; k++) length = (length << 8) | bytes[i++];
    }
    const value = bytes.slice(i, i + length);
    i += length;
    out.push({ tag: toHex(tagBytes), value });
    if (tagBytes[0] & 0x20) parseTlv(value, out);
  }
  return out;
}

const ok = (response: number[]) => response.length >= 2 && response.at(-2) === 0x90 && response.at(-1) === 0x00;

/** The brand of the tapped card, or null if it isn't a payment card. */
export async function readCardBrand(transceive: Transceive): Promise<CardBrand | null> {
  const directory = await transceive(PPSE);
  if (ok(directory)) {
    const aids = parseTlv(directory.slice(0, -2)).filter((t) => t.tag === '4F').map((t) => toHex(t.value));
    if (aids.length) return brandOf(aids[0]);
  }
  for (const aid of FALLBACK_AIDS) {
    if (ok(await transceive(selectAid(hex(aid))))) return brandOf(aid);
  }
  return null;
}
