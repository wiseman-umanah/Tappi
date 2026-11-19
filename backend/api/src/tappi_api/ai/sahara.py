"""Intron Sahara TTS: African-language voices (HoverAI: backend/app/services/sahara_tts.py).
A queue API: enqueue the text, poll until the audio is generated, download the WAV.
Typically 5–15 s, so the chat shows the reply first and the voice follows."""

import asyncio
import time
from typing import Any

import httpx

from ..settings import settings

POLL_S = 1.0

# Tests swap this for an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


async def speech(text: str, voice: dict[str, str], gender: str, deadline: float) -> bytes:
    s = settings()
    if not s.intron_api_key:
        raise RuntimeError("INTRON_API_KEY is not set")
    headers = {"authorization": f"Bearer {s.intron_api_key}"}
    async with httpx.AsyncClient(base_url=s.intron_base_url, transport=transport, timeout=15) as client:

        async def call(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            response = await client.request(method, path, headers=headers, **kwargs)
            if not response.is_success:
                raise RuntimeError(f"Sahara {path} answered {response.status_code}")
            return response.json()

        queued = await call(
            "POST",
            "/tts/v1/enqueue",
            json={
                "text": text,
                "voice_language": voice["language"],
                "voice_accent": voice["accent"],
                "voice_gender": gender,
                "output_audio_format": "wav",
            },
        )
        text_id = (queued.get("data") or {}).get("text_id")
        if queued.get("status") != "Ok" or not text_id:
            raise RuntimeError(f"Sahara enqueue failed: {queued.get('message') or queued.get('status')}")

        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_S)
            data = (await call("GET", f"/tts/v1/status/{text_id}")).get("data") or {}
            status = data.get("processing_status") or ""
            if status == "TTS_TEXT_AUDIO_GENERATED" and data.get("audio_path"):
                # A storage URL: the API key isn't sent there.
                audio = await client.get(data["audio_path"])
                if not audio.is_success:
                    raise RuntimeError(f"Sahara audio download answered {audio.status_code}")
                return audio.content
            if "FAIL" in status.upper():
                raise RuntimeError(f"Sahara TTS failed: {status}")
    raise RuntimeError("Sahara TTS timed out")
