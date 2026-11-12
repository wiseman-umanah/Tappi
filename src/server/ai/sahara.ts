import { env } from '../env';

/**
 * Intron Sahara TTS: African-language voices (HoverAI: backend/app/services/sahara_tts.py).
 * A queue API: enqueue the text, poll until the audio is generated, download the WAV.
 * Typically 5–15 s, so the chat shows the reply first and the voice follows.
 */
type Voice = { language: string; accent: string };

const POLL_MS = 1000;

async function sahara<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = env.intronApiKey;
  if (!key) throw new Error('INTRON_API_KEY is not set');
  const response = await fetch(`${env.intronBaseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Sahara ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

export async function saharaSpeech(text: string, voice: Voice, gender: 'female' | 'male', deadline: number) {
  const queued = await sahara<{ status: string; message?: string; data?: { text_id: string } }>('/tts/v1/enqueue', {
    method: 'POST',
    body: JSON.stringify({
      text,
      voice_language: voice.language,
      voice_accent: voice.accent,
      voice_gender: gender,
      output_audio_format: 'wav',
    }),
  });
  const id = queued.data?.text_id;
  if (queued.status !== 'Ok' || !id) throw new Error(`Sahara enqueue failed: ${queued.message ?? queued.status}`);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { data } = await sahara<{ data?: { processing_status?: string; audio_path?: string } }>(`/tts/v1/status/${id}`);
    const status = data?.processing_status ?? '';
    if (status === 'TTS_TEXT_AUDIO_GENERATED' && data?.audio_path) {
      const audio = await fetch(data.audio_path, { signal: AbortSignal.timeout(15_000) });
      if (!audio.ok) throw new Error(`Sahara audio download answered ${audio.status}`);
      return new Uint8Array(await audio.arrayBuffer());
    }
    if (status.toUpperCase().includes('FAIL')) throw new Error(`Sahara TTS failed: ${status}`);
  }
  throw new Error('Sahara TTS timed out');
}
