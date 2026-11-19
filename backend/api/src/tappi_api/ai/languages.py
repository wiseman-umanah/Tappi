"""Languages Tappi AI speaks, ported from HoverAI (backend/app/services/{stt,sahara_tts,vision}.py),
where they were checked against Sahara's /stt/v1/languages and /tts/v1/voices.

- `whisper`: language hint for Groq Whisper, or None to let it auto-detect. Whisper has no Pidgin,
  Igbo or the smaller languages, and a wrong hint is worse than none.
- `voice`: Sahara TTS voice_language + voice_accent, or None for Groq Orpheus (English).
- `style`: how replies are written. Everyone code-switches, so the prompt asks the model to write the
  way people actually talk: the language as the base, money words left in English.
"""

from typing import Any

LANGUAGES: list[dict[str, Any]] = [
    {
        "code": "en",
        "label": "English",
        "native": "English",
        "whisper": "en",
        "voice": None,
        "style": "Write in clear, warm, everyday Nigerian English.",
    },
    {
        "code": "en-pidgin",
        "label": "Nigerian Pidgin",
        "native": "Naija",
        "whisper": None,
        "voice": {"language": "pcm", "accent": "pidgin"},
        "style": "Write in warm, natural Nigerian Pidgin, the way a helpful Lagos friend talks: 'Your balance na "
        "₦12,000', 'I don prepare am, make you confirm with your PIN', 'E don land', 'Abeg check am'. Mix "
        "in English words where people naturally do, but keep the rhythm and feel Pidgin. Never switch to "
        "formal English.",
    },
    {
        "code": "yo",
        "label": "Yoruba",
        "native": "Yorùbá",
        "whisper": "yo",
        "voice": {"language": "yo", "accent": "yoruba"},
        "style": "Write in natural Yoruba with correct tone marks, as a helpful friend would speak. Keep money and "
        "app words in English the way people say them (naira, USDC, Tappi, send, swap, balance, account, "
        "PIN).",
    },
    {
        "code": "ha",
        "label": "Hausa",
        "native": "Hausa",
        "whisper": "ha",
        "voice": {"language": "ha", "accent": "hausa"},
        "style": "Write in natural Hausa, as a helpful friend would speak. Keep money and app words in English the "
        "way people say them (naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "ig",
        "label": "Igbo",
        "native": "Igbo",
        "whisper": None,
        "voice": {"language": "ig", "accent": "igbo"},
        "style": "Write in natural Igbo, as a helpful friend would speak. Keep money and app words in English the "
        "way people say them (naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "sw",
        "label": "Swahili",
        "native": "Kiswahili",
        "whisper": "sw",
        "voice": {"language": "sw", "accent": "swahili"},
        "style": "Write in clear, natural Swahili. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "am",
        "label": "Amharic",
        "native": "አማርኛ",
        "whisper": "am",
        "voice": {"language": "am", "accent": "amharic"},
        "style": "Write in clear, natural Amharic. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "af",
        "label": "Afrikaans",
        "native": "Afrikaans",
        "whisper": "af",
        "voice": {"language": "af", "accent": "afrikaans"},
        "style": "Write in clear, natural Afrikaans. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "zu",
        "label": "Zulu",
        "native": "isiZulu",
        "whisper": None,
        "voice": {"language": "en", "accent": "zulu"},
        "style": "Write in clear, natural Zulu. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "rw",
        "label": "Kinyarwanda",
        "native": "Ikinyarwanda",
        "whisper": None,
        "voice": {"language": "rw", "accent": "kinyarwanda"},
        "style": "Write in clear, natural Kinyarwanda. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "lg",
        "label": "Luganda",
        "native": "Luganda",
        "whisper": None,
        "voice": {"language": "lg", "accent": "luganda"},
        "style": "Write in clear, natural Luganda. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "om",
        "label": "Oromo",
        "native": "Afaan Oromoo",
        "whisper": None,
        "voice": {"language": "om", "accent": "oromo"},
        "style": "Write in clear, natural Oromo. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "sn",
        "label": "Shona",
        "native": "chiShona",
        "whisper": None,
        "voice": {"language": "sn", "accent": "shona"},
        "style": "Write in clear, natural Shona. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
    {
        "code": "wo",
        "label": "Wolof",
        "native": "Wolof",
        "whisper": None,
        "voice": {"language": "wo", "accent": "wolof"},
        "style": "Write in clear, natural Wolof. Keep money and app words in English the way people say them "
        "(naira, USDC, Tappi, send, swap, balance, account, PIN).",
    },
]

LANGUAGE_CODES = tuple(language["code"] for language in LANGUAGES)


def language_of(code: str | None) -> dict[str, Any]:
    return next((language for language in LANGUAGES if language["code"] == code), LANGUAGES[0])


def list_languages() -> dict[str, Any]:
    """For the Profile picker."""
    return {"languages": [{k: language[k] for k in ("code", "label", "native")} for language in LANGUAGES]}
