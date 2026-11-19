"""Groq's OpenAI-compatible API: Whisper (speech → text), chat with tools, and Orpheus (text →
English speech). Same providers and models as HoverAI."""

import logging
from typing import Any

import httpx

from ..errors import HttpError
from ..settings import settings

log = logging.getLogger("tappi.ai")

# Tests swap this for an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


async def _groq(path: str, *, http_timeout: float = 30, **kwargs: Any) -> httpx.Response:
    s = settings()
    if not s.groq_api_key:
        raise HttpError(503, "Tappi AI is not set up: add GROQ_API_KEY to the API's .env and restart it.")
    try:
        async with httpx.AsyncClient(base_url=s.groq_base_url, transport=transport, timeout=http_timeout) as client:
            response = await client.post(path, headers={"authorization": f"Bearer {s.groq_api_key}"}, **kwargs)
    except httpx.HTTPError as error:
        log.error("groq unreachable: %s", error)
        raise HttpError(503, "Tappi AI can't be reached right now. Try again in a moment.") from None
    if response.status_code == 429:
        raise HttpError(429, "Tappi AI is busy. Try again in a few seconds.")
    if not response.is_success:
        log.error("groq %s answered %s: %s", path, response.status_code, response.text[:500])
        raise HttpError(502, "Tappi AI had a problem. Try again.")
    return response


# ---------------- Speech → text ----------------

# Names and words Whisper should expect, so "send five k to @tunde" doesn't become nonsense.
VOCABULARY = "Tappi, naira, USDT, USDC, Bitcoin, BTC, send, balance, PIN, abeg, kobo."


async def transcribe(audio: bytes, filename: str, mime: str, language: str | None) -> str:
    data = {
        "model": settings().whisper_model,
        "response_format": "json",
        "temperature": "0",
        "prompt": VOCABULARY,
    }
    if language:
        data["language"] = language
    response = await _groq("/audio/transcriptions", data=data, files={"file": (filename, audio, mime)})
    return (response.json().get("text") or "").strip()


# ---------------- Chat ----------------


async def chat(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Returns the reply text and any tool calls."""
    body: dict[str, Any] = {
        "model": settings().ai_model,
        "messages": messages,
        "temperature": 0.4,
        "max_completion_tokens": 1024,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    response = await _groq("/chat/completions", json=body)
    message = (response.json().get("choices") or [{}])[0].get("message") or {}
    # Drop provider extras (gpt-oss returns `reasoning`) so the message can be sent back as is.
    return (message.get("content") or "").strip(), message.get("tool_calls") or []


# ---------------- Text → speech (English) ----------------

ORPHEUS_VOICES = {"female": "autumn", "male": "daniel"}


async def orpheus(text: str, gender: str = "female", http_timeout: float = 20) -> bytes:
    response = await _groq(
        "/audio/speech",
        json={"model": settings().tts_model, "voice": ORPHEUS_VOICES[gender], "input": text, "response_format": "wav"},
        http_timeout=http_timeout,
    )
    return response.content
