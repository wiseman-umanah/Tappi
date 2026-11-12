import { env } from '../env';
import { HttpError } from '../errors';

/**
 * Groq's OpenAI-compatible API over plain fetch: Whisper (speech → text), chat with tools, and
 * Orpheus (text → English speech). Same providers and models as HoverAI.
 */
const BASE = 'https://api.groq.com/openai/v1';

function apiKey() {
  try {
    return env.groqApiKey;
  } catch {
    throw new HttpError(503, 'Tappi AI is not set up: add GROQ_API_KEY to .env.local and restart `pnpm start`.');
  }
}

async function groq(path: string, init: RequestInit & { timeoutMs?: number }) {
  const key = apiKey();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (error) {
    console.error('[tappi ai] groq unreachable', error);
    throw new HttpError(503, "Tappi AI can't be reached right now. Try again in a moment.");
  }
  if (response.status === 429) throw new HttpError(429, 'Tappi AI is busy. Try again in a few seconds.');
  if (!response.ok) {
    console.error('[tappi ai] groq', path, response.status, (await response.text()).slice(0, 500));
    throw new HttpError(502, 'Tappi AI had a problem. Try again.');
  }
  return response;
}

// ---------------- Speech → text ----------------

/** Names and words Whisper should expect, so "send five k to @tunde" doesn't become nonsense. */
const VOCABULARY = 'Tappi, naira, USDC, Stellar, swap, send, balance, PIN, abeg, kobo.';

export async function transcribe(audio: Blob, filename: string, language: string | null) {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', env.whisperModel);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('prompt', VOCABULARY);
  if (language) form.append('language', language);
  const response = await groq('/audio/transcriptions', { method: 'POST', body: form });
  const data = (await response.json()) as { text?: string };
  return (data.text ?? '').trim();
}

// ---------------- Chat ----------------

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type Tool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export async function chat(messages: ChatMessage[], tools: Tool[]) {
  const response = await groq('/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.aiModel,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.4,
      max_completion_tokens: 1024,
    }),
  });
  const data = (await response.json()) as {
    choices: { message: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const message = data.choices[0]?.message;
  // Drop provider extras (gpt-oss returns `reasoning`) so the message can be sent back as is.
  return { content: message?.content?.trim() ?? '', toolCalls: message?.tool_calls ?? [] };
}

// ---------------- Text → speech (English) ----------------

const ORPHEUS_VOICES = { female: 'autumn', male: 'daniel' } as const;

export async function orpheus(text: string, gender: 'female' | 'male' = 'female', timeoutMs = 20_000) {
  const response = await groq('/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.orpheusModel, voice: ORPHEUS_VOICES[gender], input: text, response_format: 'wav' }),
    timeoutMs,
  });
  return new Uint8Array(await response.arrayBuffer());
}
