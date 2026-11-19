"""The Bitnob USD virtual Visa card (the engine does the talking). Card KYC first (BVN or NIN is
instant), then the card is created and topped up from the user's USDT or USDC; its balance lives on
the card at Bitnob. Not the Tappi card (cards.py), which is the phone itself."""

from typing import Any

from . import engine
from .db import User
from .errors import HttpError
from .money import to_major


def _present_card(card: dict[str, Any] | None) -> dict[str, Any] | None:
    if not card:
        return None
    return {
        "status": card["status"],
        "last4": card.get("last4"),
        "name": card.get("name"),
        "fundingAsset": card.get("fundingAsset"),
        "balance": to_major("USDC", int(card.get("balance") or 0)),
    }


async def overview(user: User) -> dict[str, Any]:
    """What the card screen needs: KYC state, and the card if there is one."""
    kyc = await engine.card_call("GET", f"/{user.id}/kyc")
    card = await engine.card_call("GET", f"/{user.id}")
    fees = await engine.card_call("GET", "/fees")
    return {
        "kyc": {"status": kyc.get("status", "none"), "reason": kyc.get("reason")},
        "card": _present_card(card),
        # The engine's prices (set in its .env), in dollars: what the user will actually be charged.
        "fees": {
            "creation": to_major("USDC", fees["creation"]),
            "topupFlat": to_major("USDC", fees["topup_flat"]),
            "topupPercent": fees["topup_percent_bps"] / 100,
            "percentFrom": to_major("USDC", fees["percent_from"]),
        },
    }


async def occupations() -> Any:
    return await engine.card_call("GET", "/occupations")


async def submit_kyc(user: User, form: dict[str, Any]) -> dict[str, Any]:
    if not user.email:
        raise HttpError(409, "Your account needs an email address.")
    return await engine.card_call("POST", "/kyc", {"owner_id": str(user.id), "email": user.email, **form})


def _present_op(op: dict[str, Any]) -> dict[str, Any]:
    status = op.get("status", "pending")
    return {
        "id": op.get("id"),
        "status": "pending" if status in ("created", "submitted", "pending") else status,
        "error": "It wasn't accepted. Your money is back in your balance." if status == "failed" else None,
    }


async def create(user: User, amount: int, asset: str, key: str) -> dict[str, Any]:
    card = await engine.card_call(
        "POST", f"/{user.id}/create", {"idempotency_key": key, "amount": amount, "asset": asset}
    )
    return {"status": card["status"]}


async def fund(user: User, amount: int, asset: str, key: str) -> dict[str, Any]:
    return _present_op(
        await engine.card_call("POST", f"/{user.id}/fund", {"idempotency_key": key, "amount": amount, "asset": asset})
    )


async def withdraw(user: User, amount: int, key: str) -> dict[str, Any]:
    return _present_op(
        await engine.card_call("POST", f"/{user.id}/withdraw", {"idempotency_key": key, "amount": amount})
    )


async def set_frozen(user: User, frozen: bool) -> dict[str, Any]:
    card = await engine.card_call("POST", f"/{user.id}/frozen", {"frozen": frozen})
    return {"status": card["status"]}


async def terminate(user: User) -> dict[str, Any]:
    card = await engine.card_call("POST", f"/{user.id}/terminate")
    return {"status": card["status"]}


async def details(user: User) -> dict[str, Any]:
    """Number, CVV and expiry from Bitnob: shown once, never stored."""
    return await engine.card_call("GET", f"/{user.id}/secrets")


async def transactions(user: User) -> dict[str, Any]:
    rows = await engine.card_call("GET", f"/{user.id}/transactions")
    return {"transactions": [{**row, "amount": to_major("USDC", int(row.get("amount") or 0))} for row in rows]}
