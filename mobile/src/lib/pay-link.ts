/** Charges travel as `tappi://pay/<CODE>` over NFC and QR. Returns the 6-character code, if any. */
export function parsePayLink(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/pay\/([A-Z2-9]{6})\b/i) ?? trimmed.match(/^([A-Z2-9]{6})$/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * People travel as `tappi://send/<username>` (their Receive QR code) or are typed as `@username`.
 * Returns the username, if any.
 */
export function parseSendLink(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/send\/@?([a-z0-9_]{3,20})\b/i) ?? trimmed.match(/^@([a-z0-9_]{3,20})$/i);
  return match ? match[1].toLowerCase() : null;
}

export const sendLink = (handle: string) => `tappi://send/${handle}`;
