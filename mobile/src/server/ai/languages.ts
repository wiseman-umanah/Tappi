/**
 * Languages Tappi AI speaks, ported from HoverAI (backend/app/services/{stt,sahara_tts,vision}.py),
 * where they were checked against Sahara's /stt/v1/languages and /tts/v1/voices.
 *
 * - `whisper`: language hint for Groq Whisper, or null to let it auto-detect. Whisper has no
 *   Pidgin, Igbo or the smaller languages, and a wrong hint is worse than none.
 * - `voice`: Sahara TTS voice_language + voice_accent, or null for Groq Orpheus (English).
 * - `style`: how replies are written. Everyone code-switches, so the prompt asks the model to
 *   write the way people actually talk: the language as the base, money words left in English.
 */
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

type Language = {
  code: string;
  label: string;
  /** The language's own name, shown under the English one in the picker. */
  native: string;
  whisper: string | null;
  voice: { language: string; accent: string } | null;
  style: string;
};

const keepEnglish =
  'Keep money and app words in English the way people say them (naira, USDC, Tappi, send, swap, balance, account, PIN).';

export const LANGUAGES = [
  {
    code: 'en',
    label: 'English',
    native: 'English',
    whisper: 'en',
    voice: null,
    style: 'Write in clear, warm, everyday Nigerian English.',
  },
  {
    code: 'en-pidgin',
    label: 'Nigerian Pidgin',
    native: 'Naija',
    whisper: null,
    voice: { language: 'pcm', accent: 'pidgin' },
    style:
      "Write in warm, natural Nigerian Pidgin, the way a helpful Lagos friend talks: 'Your balance na ₦12,000', " +
      "'I don prepare am, make you confirm with your PIN', 'E don land', 'Abeg check am'. " +
      'Mix in English words where people naturally do, but keep the rhythm and feel Pidgin. Never switch to formal English.',
  },
  {
    code: 'yo',
    label: 'Yoruba',
    native: 'Yorùbá',
    whisper: 'yo',
    voice: { language: 'yo', accent: 'yoruba' },
    style: `Write in natural Yoruba with correct tone marks, as a helpful friend would speak. ${keepEnglish}`,
  },
  {
    code: 'ha',
    label: 'Hausa',
    native: 'Hausa',
    whisper: 'ha',
    voice: { language: 'ha', accent: 'hausa' },
    style: `Write in natural Hausa, as a helpful friend would speak. ${keepEnglish}`,
  },
  {
    code: 'ig',
    label: 'Igbo',
    native: 'Igbo',
    whisper: null,
    voice: { language: 'ig', accent: 'igbo' },
    style: `Write in natural Igbo, as a helpful friend would speak. ${keepEnglish}`,
  },
  {
    code: 'sw',
    label: 'Swahili',
    native: 'Kiswahili',
    whisper: 'sw',
    voice: { language: 'sw', accent: 'swahili' },
    style: `Write in clear, natural Swahili. ${keepEnglish}`,
  },
  {
    code: 'am',
    label: 'Amharic',
    native: 'አማርኛ',
    whisper: 'am',
    voice: { language: 'am', accent: 'amharic' },
    style: `Write in clear, natural Amharic. ${keepEnglish}`,
  },
  {
    code: 'af',
    label: 'Afrikaans',
    native: 'Afrikaans',
    whisper: 'af',
    voice: { language: 'af', accent: 'afrikaans' },
    style: `Write in clear, natural Afrikaans. ${keepEnglish}`,
  },
  {
    code: 'zu',
    label: 'Zulu',
    native: 'isiZulu',
    whisper: null,
    // No native Zulu voice on Sahara: English voice with a Zulu accent.
    voice: { language: 'en', accent: 'zulu' },
    style: `Write in clear, natural Zulu. ${keepEnglish}`,
  },
  {
    code: 'rw',
    label: 'Kinyarwanda',
    native: 'Ikinyarwanda',
    whisper: null,
    voice: { language: 'rw', accent: 'kinyarwanda' },
    style: `Write in clear, natural Kinyarwanda. ${keepEnglish}`,
  },
  {
    code: 'lg',
    label: 'Luganda',
    native: 'Luganda',
    whisper: null,
    voice: { language: 'lg', accent: 'luganda' },
    style: `Write in clear, natural Luganda. ${keepEnglish}`,
  },
  {
    code: 'om',
    label: 'Oromo',
    native: 'Afaan Oromoo',
    whisper: null,
    voice: { language: 'om', accent: 'oromo' },
    style: `Write in clear, natural Oromo. ${keepEnglish}`,
  },
  {
    code: 'sn',
    label: 'Shona',
    native: 'chiShona',
    whisper: null,
    voice: { language: 'sn', accent: 'shona' },
    style: `Write in clear, natural Shona. ${keepEnglish}`,
  },
  {
    code: 'wo',
    label: 'Wolof',
    native: 'Wolof',
    whisper: null,
    voice: { language: 'wo', accent: 'wolof' },
    style: `Write in clear, natural Wolof. ${keepEnglish}`,
  },
] as const satisfies readonly Language[];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];

export function languageOf(code: string | null | undefined): (typeof LANGUAGES)[number] {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/** For the Profile picker. */
export function listLanguages() {
  return {
    languages: LANGUAGES.map(({ code, label, native }) => ({ code, label, native })),
  };
}
