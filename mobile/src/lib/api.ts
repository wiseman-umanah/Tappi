import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the Tappi API (backend/api) lives. Set EXPO_PUBLIC_API_URL for builds and tunnels. In
 * development without it, the API is on the same laptop as Metro, on port 8080: the phone reaches
 * it at the laptop's LAN address (run the API with API_HOST=0.0.0.0), the web build at localhost.
 */
const API_PORT = 8080;
const hostUri = Constants.expoConfig?.hostUri;
const laptop = hostUri?.split(':')[0];
const ORIGIN =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === 'web' || !laptop ? `http://localhost:${API_PORT}` : `http://${laptop}:${API_PORT}`);

// ngrok's free plan can answer with a browser warning page instead of the API; this header skips it.
const ORIGIN_HEADERS: Record<string, string> = /ngrok/.test(ORIGIN) ? { 'ngrok-skip-browser-warning': '1' } : {};

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

/** How long a request may go unanswered. Tappi AI (speech + the model) is slower than the rest. */
const timeoutFor = (path: string) => (path.startsWith('/ai/') ? 60_000 : 20_000);

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  // Without a limit, a request a firewall silently drops spins forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(path));
  try {
    response = await fetch(`${ORIGIN}/api${path}`, {
      ...init,
      headers: { ...authHeaders(), ...init.headers },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        0,
        __DEV__
          ? `No answer from the Tappi server at ${ORIGIN}. Same Wi-Fi as the laptop? Firewall open for port 8080?`
          : 'The Tappi server took too long to answer. Check your connection and try again.',
      );
    }
    // In development, say what actually failed: "Network request failed" can also be a bad upload.
    const detail = __DEV__ && error instanceof Error ? ` (${error.message})` : '';
    throw new ApiError(0, `Can't reach the Tappi server${detail}. Is the API running (backend: ./dev.sh)?`);
  } finally {
    clearTimeout(timer);
  }
  // Something other than the Tappi API answered (a proxy error page, the wrong port).
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(response.status, `The Tappi server didn't answer properly (${response.status}). Check EXPO_PUBLIC_API_URL.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized?.();
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

export function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  return request<T>(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/**
 * A fresh key for one money action. Send the same key when retrying that action, and the server
 * moves the money at most once.
 */
export function idempotencyKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** The signed-in user's authorization header, for players and other non-fetch requests. */
export function authHeaders(): Record<string, string> {
  return token ? { ...ORIGIN_HEADERS, authorization: `Bearer ${token}` } : ORIGIN_HEADERS;
}

/** Full URL of an API path, for things that load it themselves (the audio player). */
export const apiUrl = (path: string) => `${ORIGIN}/api${path}`;
