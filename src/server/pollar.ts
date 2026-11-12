import { z } from 'zod';

import { env } from './env';
import { HttpError } from './errors';

/**
 * Pollar (https://docs.pollar.xyz) signs users in and holds their Stellar wallets. The app signs in
 * with Pollar's SDK, then hands its access token to Tappi once; Tappi checks it here with Pollar's
 * Server API and issues its own session. Pollar never signs for a user from a server: every
 * transaction is signed through the SDK on the user's phone (see src/server/stellar/user-tx.ts).
 */
const Verified = z.object({
  userId: z.string().min(1),
  network: z.string().optional(),
  wallet: z.unknown().optional(),
  profile: z.unknown().optional(),
});

export type PollarUser = { id: string; email: string | null; address: string | null; network: string | null };

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** The wallet's G-address, wherever this answer puts it (a string, or an object with one). */
function stellarAddress(value: unknown): string | null {
  if (typeof value === 'string') return STELLAR_ADDRESS.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = stellarAddress(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // A multichain answer: prefer the Stellar entry.
    if (typeof v.chain === 'string' && v.chain.toUpperCase() !== 'STELLAR') return null;
    for (const key of ['address', 'publicKey', 'public_key', 'stellarAddress']) {
      const found = stellarAddress(v[key]);
      if (found) return found;
    }
    for (const key of ['stellar', 'wallet', 'wallets']) {
      const found = stellarAddress(v[key]);
      if (found) return found;
    }
  }
  return null;
}

function email(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') return null;
  const p = profile as Record<string, unknown>;
  const value = p.email ?? (p.data as Record<string, unknown> | undefined)?.email;
  return typeof value === 'string' && value.includes('@') ? value.trim().toLowerCase() : null;
}

/** Checks an SDK access token with Pollar: who it is, their email and Stellar wallet. */
export async function verifyPollarToken(token: string): Promise<PollarUser> {
  if (!process.env.POLLAR_SECRET_KEY) {
    throw new HttpError(503, 'Sign-in is not set up on the server: add POLLAR_SECRET_KEY (see .env.example).');
  }
  const response = await fetch(`${env.pollarServerUrl}/v3/tokens/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pollar-api-key': env.pollarSecretKey },
    body: JSON.stringify({ token }),
  }).catch(() => {
    throw new HttpError(503, "Can't reach Pollar to check your sign-in. Try again.");
  });
  const json = (await response.json().catch(() => null)) as { code?: string; content?: unknown } | null;
  if (response.status === 401) throw new HttpError(401, 'Your sign-in expired. Sign in again.');
  if (response.status === 403) throw new HttpError(403, 'This sign-in is for another app. Check the Pollar keys.');
  if (!response.ok || !json) {
    console.error('[tappi] Pollar token check failed', response.status, json?.code);
    throw new HttpError(502, "Couldn't check your sign-in with Pollar. Try again.");
  }
  const parsed = Verified.safeParse(json.content ?? json);
  if (!parsed.success) {
    console.error('[tappi] unexpected Pollar token answer', JSON.stringify(json).slice(0, 500));
    throw new HttpError(502, "Couldn't read your sign-in from Pollar.");
  }
  const { userId, network, wallet, profile } = parsed.data;
  return { id: userId, email: email(profile), address: stellarAddress(wallet), network: network ?? null };
}
