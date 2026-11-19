"""USDT, USDC and Bitcoin in and out through Bitnob (the engine does the talking): a deposit address
per user per network, and sending to outside addresses."""

from typing import Any
from uuid import UUID

from . import engine
from .auth import assert_own_receiving
from .db import User
from .errors import HttpError
from .money import to_major
from .wallet import needs_profile

# What the app offers; Bitnob's list per account is the final word (the engine checks it too).
NETWORKS: dict[str, list[dict[str, str]]] = {
    "USDT": [
        {"chain": "tron", "label": "Tron (TRC-20)"},
        {"chain": "ethereum", "label": "Ethereum (ERC-20)"},
        {"chain": "polygon", "label": "Polygon"},
        {"chain": "solana", "label": "Solana"},
        {"chain": "bsc", "label": "BNB Smart Chain (BEP-20)"},
    ],
    "USDC": [
        {"chain": "ethereum", "label": "Ethereum (ERC-20)"},
        {"chain": "polygon", "label": "Polygon"},
        {"chain": "solana", "label": "Solana"},
        {"chain": "base", "label": "Base"},
        {"chain": "bsc", "label": "BNB Smart Chain (BEP-20)"},
    ],
    "BTC": [{"chain": "bitcoin", "label": "Bitcoin"}],
}


def _check(asset: str, chain: str) -> None:
    if not any(n["chain"] == chain for n in NETWORKS.get(asset, [])):
        raise HttpError(400, f"{asset} isn't available on {chain}.")


async def deposit_address(user: User, asset: str, chain: str) -> dict[str, Any]:
    """Where to send `asset` on `chain` so it lands in this user's Tappi balance."""
    _check(asset, chain)
    assert_own_receiving(user)
    if needs_profile(user) or not user.email:
        raise HttpError(409, "Finish your profile to get a deposit address.")
    first, _, last = (user.name or "").partition(" ")
    account = await engine.bitnob_address(user.id, user.email, first or None, last or None, asset, chain)
    return {"asset": asset, "chain": chain, "address": account["details"]["address"]}


def _present(op: dict[str, Any]) -> dict[str, Any]:
    status = op["status"]
    return {
        "id": op["id"],
        "status": "pending" if status in ("created", "submitted", "pending") else status,
        "amount": to_major(op["asset"], op["amount"]) if op.get("asset") and op.get("amount") is not None else None,
        "error": "It couldn't be sent. Your money is back in your balance." if status == "failed" else None,
    }


async def send(user: User, asset: str, chain: str, amount: int, to_address: str, key: str) -> dict[str, Any]:
    _check(asset, chain)
    op = await engine.bitnob_send(
        key=key, user_id=user.id, asset=asset, chain=chain, amount=amount, to_address=to_address
    )
    return _present(op)


async def sent(user: User, op_id: str) -> dict[str, Any]:
    try:
        op = await engine.op(UUID(op_id))
    except ValueError:
        op = None
    if op is None or op.get("owner_id") != str(user.id):
        raise HttpError(404, "No such transfer.")
    return _present(op)
