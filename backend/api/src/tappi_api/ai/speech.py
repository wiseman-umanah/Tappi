"""Spoken replies. The chat answer goes back as text straight away with a speech id; the voice is
made in the background and the phone waits on GET /api/ai/speech/{id}/ready, then plays
GET /api/ai/speech/{id}. Sahara voices the African languages; Groq Orpheus voices English, and
stands in for Pidgin when Sahara is slow or down. Other languages go without audio rather than
being read out by an English voice. Clips live in this process's memory for a few minutes only
(the API runs as one long-lived process)."""

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from uuid import UUID, uuid4

from ..errors import HttpError
from ..settings import settings
from . import groq, sahara
from .languages import language_of

log = logging.getLogger("tappi.ai")

TTL_S = 5 * 60
# Orpheus (English only) can read these when Sahara can't.
ORPHEUS_FALLBACK = {"en", "en-pidgin"}
# Pictographs (emoji) aren't read aloud.
EMOJI = re.compile("[\U0001f000-\U0001faff☀-➿️]")


@dataclass
class Clip:
    user_id: UUID
    audio: asyncio.Task[bytes | None]
    expires: float


_clips: dict[str, Clip] = {}


def speakable(text: str) -> str:
    """Text that reads well aloud: no markdown, emoji or @, and not too long."""
    plain = re.sub(r"[*_`#>]", "", text)
    plain = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", plain)
    plain = EMOJI.sub("", plain)
    plain = re.sub(r"@(\w+)", r"\1", plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    if len(plain) <= 400:
        return plain
    cut = plain[:400]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return cut[: end + 1] if end > 100 else cut


async def _synthesise(text: str, code: str) -> bytes | None:
    language = language_of(code)
    timeout = settings().tts_timeout_s
    if language["voice"] and settings().intron_api_key:
        try:
            return await sahara.speech(text, language["voice"], "female", time.monotonic() + timeout)
        except Exception as error:
            log.warning("Sahara voice failed (%s): %s", code, error)
    if language["code"] not in ORPHEUS_FALLBACK:
        return None
    try:
        return await groq.orpheus(text, "female", timeout)
    except Exception as error:
        log.warning("Orpheus voice failed: %s", getattr(error, "message", error))
        return None


def start_speech(user_id: UUID, text: str, language: str) -> str | None:
    """Starts voicing `text`; returns the id the phone fetches it with, or None if there's nothing to say."""
    now = time.monotonic()
    for clip_id in [k for k, c in _clips.items() if c.expires < now]:
        _clips.pop(clip_id).audio.cancel()
    spoken = speakable(text)
    if not spoken:
        return None
    clip_id = str(uuid4())
    _clips[clip_id] = Clip(user_id, asyncio.create_task(_synthesise(spoken, language)), now + TTL_S)
    return clip_id


def _clip(user_id: UUID, clip_id: str) -> Clip:
    clip = _clips.get(clip_id)
    if clip is None or clip.user_id != user_id:
        raise HttpError(404, "That reply has no audio any more.")
    return clip


async def speech_ready(user_id: UUID, clip_id: str) -> dict[str, bool]:
    """Waits until the voice is made. The phone asks this first: its audio player gives up on a URL
    that takes as long as Sahara does."""
    return {"ready": (await _clip(user_id, clip_id).audio) is not None}


async def speech_audio(user_id: UUID, clip_id: str) -> bytes:
    audio = await _clip(user_id, clip_id).audio
    if audio is None:
        raise HttpError(404, "That reply has no audio.")
    return audio
