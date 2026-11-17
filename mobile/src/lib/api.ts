import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the Tappi API lives. In development it is the same server that serves the app
 * (`pnpm start`), so on a phone that's the laptop's address; set EXPO_PUBLIC_API_URL once the
 * backend is hosted somewhere else.
 */
const hostUri = Constants.expoConfig?.hostUri;
// `pnpm start:remote` serves through an https tunnel (*.on.expo.app) that redirects plain http,
// and a redirect turns POSTs into GETs. A LAN address carries a port; the tunnel host doesn't.
const scheme = hostUri?.includes(':') ? 'http' : 'https';
const ORIGIN = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' || !hostUri ? '' : `${scheme}://${hostUri}`);

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

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ORIGIN}/api${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } });
  } catch (error) {
    // In development, say what actually failed: "Network request failed" can also be a bad upload.
    const detail = __DEV__ && error instanceof Error ? ` (${error.message})` : '';
    throw new ApiError(0, `Can't reach the Tappi server${detail}. Is \`pnpm start\` running on your laptop?`);
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

export function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** The signed-in user's authorization header, for players and other non-fetch requests. */
export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Full URL of an API path, for things that load it themselves (the audio player). */
export const apiUrl = (path: string) => `${ORIGIN}/api${path}`;
