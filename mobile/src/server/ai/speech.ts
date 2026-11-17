import { randomUUID } from 'node:crypto';

import { env } from '../env';
import { HttpError } from '../errors';
import { orpheus } from './groq';
import { languageOf } from './languages';
import { saharaSpeech } from './sahara';

/**
 * Spoken replies. The chat answer goes back as text straight away with a speech id; the voice is
 * made in the background and the phone waits on GET /api/ai/speech/:id/ready, then plays
 * GET /api/ai/speech/:id. Sahara voices the African languages; Groq Orpheus voices English, and stands in for
 * Pidgin when Sahara is slow or down. Other languages go without audio rather than being read
 * out by an English voice. Clips live in memory for a few minutes only.
 */
const TTL_MS = 5 * 60_000;
/** Orpheus (English only) can read these when Sahara can't. */
const ORPHEUS_FALLBACK = new Set(['en', 'en-pidgin']);

type Clip = { userId: string; audio: Promise<Uint8Array | null>; expires: number };

// On globalThis: API routes are bundled separately but must share the clips.
const store = globalThis as typeof globalThis & { __tappiSpeech?: Map<string, Clip> };
const clips = (store.__tappiSpeech ??= new Map());

/** Text that reads well aloud: no markdown, emoji or @, and not too long. */
export function speakable(text: string) {
  const plain = text
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/@(\w+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= 400) return plain;
  const cut = plain.slice(0, 400);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 100 ? cut.slice(0, end + 1) : cut;
}

async function synthesise(text: string, code: string): Promise<Uint8Array | null> {
  const language = languageOf(code);
  if (language.voice && env.intronApiKey) {
    try {
      return await saharaSpeech(text, language.voice, 'female', Date.now() + env.ttsTimeoutMs);
    } catch (error) {
      console.warn(`[tappi ai] Sahara voice failed (${code}):`, error instanceof Error ? error.message : error);
    }
  }
  if (!ORPHEUS_FALLBACK.has(language.code)) return null;
  try {
    return await orpheus(text, 'female', env.ttsTimeoutMs);
  } catch (error) {
    console.warn('[tappi ai] Orpheus voice failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Starts voicing `text`; returns the id the phone fetches it with, or null if there's nothing to say. */
export function startSpeech(userId: string, text: string, language: string) {
  const now = Date.now();
  for (const [id, clip] of clips) if (clip.expires < now) clips.delete(id);
  const spoken = speakable(text);
  if (!spoken) return null;
  const id = randomUUID();
  const audio = synthesise(spoken, language);
  clips.set(id, { userId, audio, expires: now + TTL_MS });
  return id;
}

function clipFor(userId: string, id: string) {
  const clip = clips.get(id);
  if (!clip || clip.userId !== userId) throw new HttpError(404, 'That reply has no audio any more.');
  return clip;
}

/**
 * Waits until the voice is made. The phone asks this first: its audio player gives up on a URL
 * that takes as long as Sahara does.
 */
export async function speechReady(userId: string, id: string) {
  return { ready: (await clipFor(userId, id).audio) !== null };
}

/** The finished clip as WAV. */
export async function speechResponse(userId: string, id: string) {
  const audio = await clipFor(userId, id).audio;
  if (!audio) throw new HttpError(404, 'That reply has no audio.');
  return new Response(audio, {
    headers: { 'content-type': 'audio/wav', 'content-length': String(audio.byteLength), 'cache-control': 'private, max-age=300' },
  });
}
