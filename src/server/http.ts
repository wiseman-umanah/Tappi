import { z } from 'zod';

import { authenticate } from './auth';
import { HttpError } from './errors';

export { HttpError };

type Handler<P> = (request: Request, params: P) => Promise<unknown>;

/** Wraps an API route: JSON in, JSON out, errors become `{ error }` with a sensible status. */
export function route<P = Record<string, string>>(handler: Handler<P>) {
  return async (request: Request, params: P) => {
    try {
      const result = await handler(request, params);
      return result instanceof Response ? result : Response.json(result ?? { ok: true });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof z.ZodError) {
        return Response.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
      }
      console.error('[tappi api]', error);
      // Stellar failures carry a friendly message (see stellar/submit.ts).
      const message = error instanceof Error ? error.message : 'Something went wrong';
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

export async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const json = await request.json().catch(() => ({}));
  return schema.parse(json);
}

/**
 * The signed-in user, or a 401. An account waiting to be deleted can only read /me and restore
 * itself (`restoring: true`).
 */
export async function requireUser(request: Request, { restoring = false } = {}) {
  const user = await authenticate(request);
  if (!user || user.status === 'closed') throw new HttpError(401, 'Please sign in again.');
  if (user.status === 'deleting' && !restoring) throw new HttpError(403, 'This account is being deleted. Restore it to continue.');
  return user;
}

export const pinField = z.string().regex(/^\d{4}$/, 'Enter your 4-digit PIN');
export const assetField = z.enum(['NGN', 'USDC']);
export const amountField = z.coerce.number().positive('Enter an amount').max(1_000_000_000);
