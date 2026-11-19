import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, engine, errors
from .account import purge_forever
from .banking import follow_events
from .routes import router
from .settings import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    interval = settings().purge_interval_s
    tasks = [asyncio.create_task(purge_forever(interval))] if interval > 0 else []
    if settings().follow_engine_events:
        tasks.append(asyncio.create_task(follow_events()))
    yield
    for task in tasks:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    await engine.close()
    await db.dispose()


# Groups in the API docs (/docs), by path. First match wins.
DOC_GROUPS = [
    ("/api/auth", "Sign-in"),
    ("/api/me", "Profile and account"),
    ("/api/handles", "Profile and account"),
    ("/api/users", "Send money"),
    ("/api/send", "Send money"),
    ("/api/activity", "Send money"),
    ("/api/rate", "Send money"),
    ("/api/wallet/bank-account", "Bank (Paga)"),
    ("/api/banks", "Bank (Paga)"),
    ("/api/withdraw", "Bank (Paga)"),
    ("/api/crypto", "Crypto (Bitnob)"),
    ("/api/swap", "Swaps (Bitnob)"),
    ("/api/usd-card", "USD card (Bitnob)"),
    ("/api/requests", "Merchant charges"),
    ("/api/merchant", "Merchant charges"),
    ("/api/taps", "Taps and nearby"),
    ("/api/nearby", "Taps and nearby"),
    ("/api/card", "Tappi card"),
    ("/api/ai", "Tappi AI"),
    ("/api/webhooks", "Provider webhooks"),
    ("/api/health", "Health"),
]

DESCRIPTION = """What the Tappi app talks to. Money moves through the Rust engine (backend/engine).

**Try it:** `POST /api/auth/code` with an email → while TAPPI_AUTO_CODE is on the response has `devCode` →
`POST /api/auth/verify` → copy `token` → **Authorize** (top right) → every other route works.
New users: `PATCH /api/me` (name, handle, gender) then `POST /api/me/pin` before moving money.

Amounts are whole units (₦1250.50, 2.5 USDC). Errors are `{"error": "message"}`. Money actions take
an optional `Idempotency-Key` header: the same key on a retry never moves money twice."""


def create_app() -> FastAPI:
    app = FastAPI(title="Tappi API", description=DESCRIPTION, version="0.1.0", lifespan=lifespan)
    if settings().cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings().cors_origins,
            allow_methods=["*"],
            allow_headers=["authorization", "content-type", "idempotency-key"],
        )
    errors.install(app)
    # Grouped on the router's own routes, before including it (newer FastAPI doesn't copy them).
    for route in router.routes:
        path = getattr(route, "path", "")
        group = next((name for prefix, name in DOC_GROUPS if path.startswith(prefix)), None)
        if group and hasattr(route, "tags"):
            route.tags = [group]
    app.include_router(router)
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    # httpx logs every request at INFO; the event follower asks the engine every few seconds.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    s = settings()  # fail fast on missing configuration
    uvicorn.run("tappi_api:create_app", factory=True, host=s.api_host, port=s.api_port, proxy_headers=True)
