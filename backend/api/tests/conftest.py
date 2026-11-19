"""Each test run gets its own database, migrated by Alembic (schema `app`) and by a real engine
process (schema `engine`) started from backend/engine. Needs `docker compose up -d db` and
`cargo build` in backend/engine."""

import asyncio
import os
import secrets
import socket
import subprocess
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager

ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL", "postgresql://tappi:tappi@127.0.0.1:5433/tappi")
ROOT = Path(__file__).resolve().parents[1]
ENGINE_BIN = ROOT.parent / "engine" / "target" / "debug" / "tappi-engine"
ENGINE_TOKEN = "test-engine-token-" + "x" * 32


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def database() -> Iterator[str]:
    name = f"tappi_api_test_{secrets.token_hex(4)}"

    async def admin(sql: str) -> None:
        conn = await asyncpg.connect(ADMIN_URL)
        try:
            await conn.execute(sql)
        finally:
            await conn.close()

    asyncio.run(admin(f'CREATE DATABASE "{name}"'))
    base = ADMIN_URL.rsplit("/", 1)[0]
    yield f"{base}/{name}"
    asyncio.run(admin(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))


@pytest.fixture(scope="session")
def engine_url(database: str) -> Iterator[str]:
    if not ENGINE_BIN.exists():
        pytest.exit(f"Build the engine first: cd {ENGINE_BIN.parents[2]} && cargo build", returncode=1)
    port = _free_port()
    process = subprocess.Popen(
        [str(ENGINE_BIN)],
        env={
            **os.environ,
            "DATABASE_URL": database.replace("postgresql://", "postgres://"),
            "ENGINE_TOKEN": ENGINE_TOKEN,
            "ENGINE_SANDBOX": "true",
            "ENGINE_ADDR": f"127.0.0.1:{port}",
            "RUST_LOG": "warn",
        },
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 30
    while True:
        try:
            if httpx.get(f"{url}/health").is_success:
                break
        except httpx.HTTPError:
            pass
        if process.poll() is not None or time.monotonic() > deadline:
            process.kill()
            pytest.exit("the engine didn't start", returncode=1)
        time.sleep(0.2)
    yield url
    process.terminate()
    process.wait(timeout=10)


@pytest.fixture(scope="session")
def configured(database: str, engine_url: str) -> None:
    async_url = database.replace("postgresql://", "postgresql+asyncpg://")
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["database_url"] = async_url
    command.upgrade(config, "head")

    os.environ.update(
        TAPPI_ENV_FILE="",
        INTRON_API_KEY="",
        DATABASE_URL=async_url,
        SESSION_SECRET="test-session-secret-" + "s" * 32,
        ENGINE_URL=engine_url,
        ENGINE_TOKEN=ENGINE_TOKEN,
        TAPPI_AUTO_CODE="true",
        PURGE_INTERVAL_S="0",
        FOLLOW_ENGINE_EVENTS="false",
        GROQ_API_KEY="test-groq-key",
    )
    from tappi_api.settings import settings

    settings.cache_clear()


@pytest.fixture(scope="session")
async def client(configured: None) -> AsyncIterator[httpx.AsyncClient]:
    from tappi_api import create_app

    app = create_app()
    async with LifespanManager(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class Person:
    """A signed-in test user."""

    def __init__(self, client: httpx.AsyncClient, token: str, handle: str | None, engine_url: str):
        self.client = client
        self.handle = handle
        self.headers = {"authorization": f"Bearer {token}"}
        self.engine_url = engine_url

    async def fund(self, asset: str, amount: str) -> None:
        """Test money, straight from the engine's test-only mint (the app has no such thing: real
        money arrives through Paga or Bitnob)."""
        from tappi_api.money import to_minor

        user_id = (await self.get("/api/me")).json()["user"]["id"]
        async with httpx.AsyncClient(base_url=self.engine_url) as engine:
            response = await engine.post(
                "/v1/sandbox/credit",
                headers={"authorization": f"Bearer {ENGINE_TOKEN}"},
                json={
                    "idempotency_key": secrets.token_hex(8),
                    "owner_id": user_id,
                    "asset": asset,
                    "amount": to_minor(asset, amount),
                },
            )
            assert response.status_code == 201, response.text

    async def get(self, path: str, **kw) -> httpx.Response:
        return await self.client.get(path, headers=self.headers, **kw)

    async def post(self, path: str, json: dict | None = None, headers: dict | None = None) -> httpx.Response:
        return await self.client.post(path, json=json, headers={**self.headers, **(headers or {})})

    async def patch(self, path: str, json: dict) -> httpx.Response:
        return await self.client.patch(path, json=json, headers=self.headers)

    async def balances(self) -> dict[str, float]:
        return (await self.get("/api/me")).json()["wallet"]["balances"]


async def sign_in(client: httpx.AsyncClient, email: str) -> str:
    code = (await client.post("/api/auth/code", json={"email": email})).json()["devCode"]
    response = await client.post("/api/auth/verify", json={"email": email, "code": code})
    assert response.status_code == 200, response.text
    return response.json()["token"]


@pytest.fixture
def make_person(client: httpx.AsyncClient, engine_url: str):
    """Signs up a new user with a profile and the PIN 1234, holding ₦50,000 and 25 USDC of test money
    (`funded=False` for an empty account)."""

    async def make(profile: bool = True, pin: str | None = "1234", funded: bool = True) -> Person:
        tag = secrets.token_hex(4)
        token = await sign_in(client, f"user{tag}@example.com")
        person = Person(client, token, f"user_{tag}" if profile else None, engine_url)
        if profile:
            r = await person.patch("/api/me", {"name": f"Test {tag}", "handle": person.handle, "gender": "female"})
            assert r.status_code == 200, r.text
            if funded:
                await person.fund("NGN", "50000")
                await person.fund("USDC", "25")
        if pin:
            assert (await person.post("/api/me/pin", {"pin": pin})).status_code == 200
        return person

    return make


@pytest.fixture
def sql(database: str):
    """Runs SQL on the test database directly: for winding clocks forward (expiry, restore windows)."""

    async def run(query: str, *args):
        conn = await asyncpg.connect(database)
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    return run
