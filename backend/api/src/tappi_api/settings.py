import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Where the API listens. 0.0.0.0 lets a phone on the same Wi-Fi reach it in development.
    api_host: str = "127.0.0.1"
    api_port: int = 8080
    # Browser origins allowed to call the API (the web build in development, e.g.
    # ["http://localhost:8081"]). The phone app doesn't need this.
    cors_origins: list[str] = []
    # postgresql+asyncpg://… — the same database as the engine; the API only uses schema `app`.
    database_url: str
    # Peppers login-code and session hashes.
    session_secret: str = Field(min_length=32)
    engine_url: str = "http://127.0.0.1:8090"
    engine_token: str = Field(min_length=32)
    # Until real email sending exists, the login code comes back in the response so the app can fill
    # it in (anyone with the app could sign in as anyone: testers only).
    tappi_auto_code: bool = True
    account_restore_days: float = 30
    # Display only (dashboard totals that mix naira and dollars). Never used to move money; replaced
    # by Bitnob's live rate when swaps arrive.
    ngn_per_usd: float = 1569
    # Merchants' "today" and "this week" follow this clock.
    timezone: str = "Africa/Lagos"
    # How often deleted accounts past their restore window are closed. 0 = never (run tappi-purge).
    purge_interval_s: int = 600
    # Turn engine events (deposits, payouts) into activity in the background. Tests do it by hand.
    follow_engine_events: bool = True

    # Tappi AI. Groq: Whisper (speech → text), the chat model, Orpheus (English voice).
    groq_api_key: str | None = None
    groq_base_url: str = "https://api.groq.com/openai/v1"
    ai_model: str = "openai/gpt-oss-120b"
    whisper_model: str = "whisper-large-v3"
    tts_model: str = "canopylabs/orpheus-v1-english"
    # Intron Sahara: African-language voices. Without a key replies are voiced by Orpheus (English, Pidgin).
    intron_api_key: str | None = None
    intron_base_url: str = "https://infer.voice.intron.io"
    # Seconds each voice provider gets before a reply goes without audio (Sahara is slow).
    tts_timeout_s: float = 12


@lru_cache
def settings() -> Settings:
    # TAPPI_ENV_FILE="" reads the environment only (tests: never your real keys from .env).
    env_file = os.environ.get("TAPPI_ENV_FILE", ".env") or None
    return Settings(_env_file=env_file)  # type: ignore[call-arg]
