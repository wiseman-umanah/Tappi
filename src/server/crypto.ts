import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from './env';

// Tappi holds no wallet keys (Pollar does), so there is nothing to encrypt here: only hashes and
// random tokens for sessions.

export function hmac(value: string): string {
  return createHmac('sha256', env.sessionSecret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
