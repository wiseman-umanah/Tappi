import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the Tappi API lives. In development it is the same server that serves the app
 * (`pnpm start`), so on a phone that's the laptop's address; set EXPO_PUBLIC_API_URL once the
 * backend is hosted somewhere else.
 */
const hostUri = Constants.expoConfig?.hostUri;
const ORIGIN = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' || !hostUri ? '' : `http://${hostUri}`);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureApi(options: { token: string | null; onUnauthorized?: () => void }) {
  token = options.token;
  if (options.onUnauthorized) onUnauthorized = options.onUnauthorized;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ORIGIN}/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the Tappi server. Is `pnpm start` running on your laptop?");
  }
  // A dev server started before the API routes existed answers /api/* with the app's HTML.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(response.status, 'The Tappi server is out of date. Restart `pnpm start` on your laptop.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized?.();
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}
