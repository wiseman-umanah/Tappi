"""Swaps between NGN, USDT, USDC and BTC (Bitnob's trading API, through the engine). The engine keeps
each quote, so executing one uses Bitnob's amounts, never amounts sent by the app."""

from typing import Any
from uuid import UUID

from . import engine
from .db import User
from .errors import HttpError
from .money import to_major

ASSETS = ("NGN", "USDT", "USDC", "BTC")


def _present_quote(q: dict[str, Any]) -> dict[str, Any]:
    return {
        "quoteId": q["id"],
        "from": q["from_asset"],
        "to": q["to_asset"],
        # What the user pays and gets, exactly.
        "send": to_major(q["from_asset"], q["send_amount"]),
        "receive": to_major(q["to_asset"], q["receive_amount"]),
        "expiresAt": q["expires_at"],
        # Test money mode (ENGINE_SANDBOX): filled at fixed test rates, not a market trade.
        "test": bool((q.get("order_request") or {}).get("test")),
    }


async def quote(user: User, from_asset: str, to_asset: str, amount: int) -> dict[str, Any]:
    if from_asset == to_asset:
        raise HttpError(400, "Pick two different currencies.")
    return _present_quote(await engine.swap_quote(user.id, from_asset, to_asset, amount))


async def execute(user: User, quote_id: str) -> dict[str, Any]:
    op = await engine.swap(user.id, quote_id)
    status = op["status"]
    request = op.get("request") or {}
    to_asset = request.get("to")
    return {
        "id": op["id"],
        "status": "pending" if status in ("created", "submitted", "pending") else status,
        "received": to_major(to_asset, request["receive"]) if to_asset and "receive" in request else None,
        "to": to_asset,
        "error": "The swap didn't go through. Your money is back in your balance." if status == "failed" else None,
    }


async def status(user: User, op_id: str) -> dict[str, Any]:
    try:
        op = await engine.op(UUID(op_id))
    except ValueError:
        op = None
    if op is None or op.get("owner_id") != str(user.id):
        raise HttpError(404, "No such swap.")
    request = op.get("request") or {}
    return {
        "id": op["id"],
        "status": "pending" if op["status"] in ("created", "submitted", "pending") else op["status"],
        "received": to_major(request["to"], request["receive"]) if "to" in request and "receive" in request else None,
        "to": request.get("to"),
        "error": "The swap didn't go through. Your money is back in your balance."
        if op["status"] == "failed"
        else None,
    }
