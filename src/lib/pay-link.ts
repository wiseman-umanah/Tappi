/** Charges travel as `tappi://pay/<CODE>` over NFC and QR. Returns the 6-character code, if any. */
export function parsePayLink(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/pay\/([A-Z2-9]{6})\b/i) ?? trimmed.match(/^([A-Z2-9]{6})$/i);
  return match ? match[1].toUpperCase() : null;
}
