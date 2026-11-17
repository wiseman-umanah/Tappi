import { randomInt } from 'node:crypto';

import { and, inArray, ne } from 'drizzle-orm';

import type { User } from './auth';
import { db, schema } from './db';

export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set([
  'tappi', 'admin', 'support', 'help', 'stellar', 'merchant', 'official', 'team', 'security',
  'billing', 'payments', 'pay', 'settings', 'system', 'root', 'me',
]);

export const normalizeHandle = (raw: string) => raw.trim().replace(/^@/, '').toLowerCase();

/** Handles from `candidates` someone else holds (a deleting account keeps its handle until closed). */
async function taken(candidates: string[], selfId: string) {
  if (!candidates.length) return new Set<string>();
  const rows = await (await db())
    .select({ handle: schema.users.handle })
    .from(schema.users)
    .where(and(inArray(schema.users.handle, candidates), ne(schema.users.id, selfId)));
  return new Set([...rows.map((r) => r.handle as string), ...candidates.filter((c) => RESERVED.has(c))]);
}

export async function isHandleTaken(handle: string, selfId: string) {
  return (await taken([handle], selfId)).has(handle);
}

async function suggest(user: User, handle: string, name?: string) {
  const words = (name || user.name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words.at(-1) : undefined;
  const base = (handle.replace(/_?\d+$/, '') || handle).slice(0, 15);
  // Alternate name-based and username-based ideas so the top three offer both.
  const pool = [
    first && last ? `${first}${last}` : null,
    `${base}${randomInt(10, 100)}`,
    first && last ? `${first}_${last}` : null,
    `${base}_ng`,
    first && last ? `${first[0]}${last}` : null,
    `the${base}`,
    `${base}${randomInt(100, 1000)}`,
  ].filter((c): c is string => Boolean(c) && HANDLE_PATTERN.test(c!) && c !== handle);
  const unique = [...new Set(pool)];
  const held = await taken(unique, user.id);
  return unique.filter((c) => !held.has(c)).slice(0, 3);
}

/** Live username check for the profile form, with suggestions when it's taken. */
export async function checkHandle(user: User, raw: string, name?: string) {
  const handle = normalizeHandle(raw);
  if (!HANDLE_PATTERN.test(handle)) {
    return { handle, available: false, message: 'Use 3–20 letters, numbers or _', suggestions: [] as string[] };
  }
  if (!(await isHandleTaken(handle, user.id))) return { handle, available: true, message: `@${handle} is available`, suggestions: [] };
  return { handle, available: false, message: `@${handle} is taken`, suggestions: await suggest(user, handle, name) };
}
