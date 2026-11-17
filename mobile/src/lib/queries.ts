import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Activity, AiConversation, AiConversations, AiLanguages, Asset, Dashboard, HandleCheck, Me, PaymentRequest, Quote, Recipient } from '@/lib/api-types';
import { useDebounced } from '@/lib/use-debounced';
import { useSession } from '@/lib/session';

export function useMe() {
  const { status } = useSession();
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), enabled: status === 'signedIn' });
}

export function useActivity() {
  return useQuery({ queryKey: ['activity'], queryFn: () => api<Activity>('/activity') });
}

export function useMerchant() {
  return useQuery({ queryKey: ['merchant'], queryFn: () => api<Dashboard>('/merchant') });
}

/** Live NGN per USDC. */
export function useRate() {
  return useQuery({
    queryKey: ['rate'],
    queryFn: async () => (await api<Quote>('/swap/quote?from=USDC&amount=1')).rate,
    staleTime: 30_000,
  });
}

export function useQuote(from: Asset, amount: number) {
  return useQuery({
    queryKey: ['quote', from, amount],
    queryFn: () => api<Quote>(`/swap/quote?from=${from}&amount=${amount}`),
    enabled: amount > 0,
    staleTime: 10_000,
  });
}

export function useRecipient(handle: string) {
  const clean = handle.trim().replace(/^@/, '').toLowerCase();
  return useQuery({
    queryKey: ['recipient', clean],
    queryFn: () => api<Recipient>(`/users/${encodeURIComponent(clean)}`),
    enabled: /^[a-z0-9_]{3,20}$/.test(clean),
    retry: false,
  });
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export type HandleState =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'invalid' | 'error' | 'available'; message: string }
  | { state: 'taken'; message: string; suggestions: string[] };

/** Live username availability while typing; `current` is the user's own handle (always fine). */
export function useHandleCheck(handle: string, name: string, current?: string | null): HandleState {
  const debounced = useDebounced(handle, 400);
  const debouncedName = useDebounced(name.trim(), 400);
  const unchanged = Boolean(current) && handle === current;
  const query = useQuery({
    queryKey: ['handle', debounced, debouncedName],
    queryFn: () => api<HandleCheck>(`/handles/${debounced}?name=${encodeURIComponent(debouncedName)}`),
    enabled: HANDLE_RE.test(debounced) && debounced === handle && !unchanged,
    // Typing the name only refreshes suggestions; keep showing the last answer meanwhile.
    placeholderData: (previous) => (previous?.handle === debounced ? previous : undefined),
    retry: false,
    staleTime: 30_000,
  });

  if (!handle) return { state: 'idle' };
  if (unchanged) return { state: 'current' };
  if (!HANDLE_RE.test(handle)) {
    return { state: 'invalid', message: handle.length < 3 ? 'At least 3 characters' : 'Use letters, numbers or _' };
  }
  if (debounced !== handle || !query.data) {
    return query.isError ? { state: 'error', message: query.error.message } : { state: 'checking' };
  }
  const { available, message, suggestions } = query.data;
  return available ? { state: 'available', message } : { state: 'taken', message, suggestions };
}

/** A charge; both phones poll it while it's open. */
export function usePaymentRequest(idOrCode: string | undefined, poll = false) {
  return useQuery({
    queryKey: ['request', idOrCode],
    queryFn: () => api<PaymentRequest>(`/requests/${idOrCode}`),
    enabled: Boolean(idOrCode),
    retry: false,
    refetchInterval: (query) => (poll && query.state.data?.state === 'pending' ? 1500 : false),
  });
}

/** Call after anything that moves money. */
export function useRefreshMoney() {
  const client = useQueryClient();
  return () =>
    Promise.all(['me', 'activity', 'merchant'].map((key) => client.invalidateQueries({ queryKey: [key] })));
}

/** The user's Tappi AI chats, most recent first. */
export function useAiConversations() {
  return useQuery({ queryKey: ['ai-conversations'], queryFn: () => api<AiConversations>('/ai/conversations') });
}

/** One Tappi AI chat (null = a new one, nothing to load). */
export function useAiConversation(id: string | null) {
  return useQuery({
    queryKey: ['ai-conversation', id],
    queryFn: () => api<AiConversation>(`/ai/conversations/${id}`),
    enabled: id != null,
  });
}

/** Languages Tappi AI speaks. */
export function useAiLanguages() {
  return useQuery({ queryKey: ['ai-languages'], queryFn: () => api<AiLanguages>('/ai/languages'), staleTime: Infinity });
}
