import { z } from 'zod';

import type { User } from '../auth';
import { HttpError } from '../errors';
import { converse } from './assistant';
import { transcribe } from './groq';
import { languageOf } from './languages';

/** ~10 MB of audio once decoded; a minute of speech is a few hundred KB. */
const MAX_BASE64 = 14_000_000;

export const VoiceInput = z.object({
  /** The recording, base64. JSON rather than multipart: React Native's multipart upload is flaky on Android. */
  audio: z.string().min(100, 'No recording came through. Try again.').max(MAX_BASE64, 'That recording is too long. Keep it under a minute.'),
  /** File type, e.g. m4a (phones) or webm (browser). */
  format: z.enum(['m4a', 'webm', 'wav', 'mp3']).default('m4a'),
  conversationId: z.uuid().nullish(),
  speak: z.boolean().default(true),
});

const MIME = { m4a: 'audio/mp4', webm: 'audio/webm', wav: 'audio/wav', mp3: 'audio/mpeg' } as const;

/** A spoken message: Whisper turns it into text, then it's an ordinary chat turn. */
export async function voiceTurn(user: User, input: z.infer<typeof VoiceInput>) {
  const bytes = Buffer.from(input.audio, 'base64');
  if (bytes.length < 100) throw new HttpError(400, 'No recording came through. Try again.');
  const audio = new Blob([bytes], { type: MIME[input.format] });

  const transcript = await transcribe(audio, `voice.${input.format}`, languageOf(user.language).whisper);
  if (!transcript) throw new HttpError(422, "I didn't catch that. Hold the mic and try again.");
  return converse(user, transcript, { conversationId: input.conversationId, spoken: true, speak: input.speak });
}
