"""Naira in and out through Paga (the engine does the talking): each user's own account number for
deposits, bank withdrawals, and the events that turn into activity ("₦5,000 from Chidi Okafor")."""

import asyncio
import logging
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, Integer, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from . import engine
from .auth import assert_own_receiving
from .db import Base, User, sessionmaker
from .errors import HttpError
from .money import to_major
from .wallet import needs_profile, record

log = logging.getLogger("tappi")


class EngineCursor(Base):
    """The last engine event the API has turned into activity (one row)."""

    __tablename__ = "engine_cursor"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_event_id: Mapped[int] = mapped_column(BigInteger, default=0)


def _present_account(account: dict[str, Any]) -> dict[str, Any]:
    details = account.get("details") or {}
    return {
        "accountNumber": details.get("accountNumber") or account["external_id"],
        "accountName": details.get("accountName"),
        "bankName": details.get("bankName", "Paga"),
    }


async def bank_account(user: User, create: bool) -> dict[str, Any] | None:
    """The user's own NGN account number: money sent to it lands in their Tappi naira balance."""
    accounts = await engine.provider_accounts(user.id)
    existing = next((a for a in accounts if a["provider"] == "paga" and a["kind"] == "nuban"), None)
    if existing:
        return _present_account(existing)
    if not create:
        return None
    assert_own_receiving(user)
    if needs_profile(user) or not user.name:
        raise HttpError(409, "Finish your profile (with your full name) to get an account number.")
    return _present_account(await engine.paga_account(user.id, user.name, user.email, None))


async def banks() -> dict[str, Any]:
    rows = await engine.paga_banks()
    return {"banks": sorted(({"uuid": b["uuid"], "name": b["name"]} for b in rows), key=lambda b: b["name"])}


async def resolve(bank_uuid: str, account_number: str, amount: int) -> dict[str, Any]:
    """Who owns the account, before sending (and Paga's fee, which Tappi pays)."""
    try:
        found = await engine.paga_resolve(bank_uuid, account_number, amount)
    except HttpError as error:
        if error.status == 404:
            raise HttpError(404, "That account number doesn't match the bank.") from None
        raise
    return {"accountName": found.get("accountName")}


def _present_op(op: dict[str, Any]) -> dict[str, Any]:
    status = op["status"]
    return {
        "id": op["id"],
        "status": "pending" if status in ("created", "submitted", "pending") else status,
        "amount": to_major("NGN", op["amount"]) if op.get("amount") is not None else None,
        "error": "The bank refused the transfer. Your money is back in your balance." if status == "failed" else None,
    }


async def withdraw(
    user: User, amount: int, bank_uuid: str, account_number: str, account_name: str | None, key: str
) -> dict[str, Any]:
    if amount < 10_000:
        raise HttpError(400, "The smallest withdrawal is ₦100.")
    op = await engine.paga_payout(
        key=key,
        user_id=user.id,
        amount=amount,
        bank_uuid=bank_uuid,
        account_number=account_number,
        account_name=account_name,
    )
    return _present_op(op)


async def withdrawal(user: User, op_id: str) -> dict[str, Any]:
    try:
        op = await engine.op(UUID(op_id))
    except ValueError:
        op = None
    if op is None or op.get("owner_id") != str(user.id):
        raise HttpError(404, "No such withdrawal.")
    return _present_op(op)


# ---------------- Engine events → activity ----------------


async def _apply(db: AsyncSession, event: dict[str, Any]) -> None:
    payload = event["payload"]
    user_id = UUID(event["owner_id"])
    if await db.get(User, user_id) is None:
        return
    if event["kind"] == "deposit":
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="deposit", title=payload.get("from") or "Bank transfer", tag="Deposit", asset=payload["asset"], amount=payload["amount"], channel="bank"),
        )  # fmt: skip
    elif event["kind"] == "swap":
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="swap", title=f"{payload['from']} → {payload['to']}", tag="Swap", asset=payload["from"], amount=-payload["sent"], asset_in=payload["to"], amount_in=payload["received"]),
        )  # fmt: skip
    elif event["kind"] == "card_load":
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="payment_out", title="To your USD card", tag="Card", asset=payload["asset"], amount=-payload["amount"], channel="usd_card"),
        )  # fmt: skip
    elif event["kind"] == "card_withdraw":
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="deposit", title="From your USD card", tag="Card", asset=payload["asset"], amount=payload["amount"], channel="usd_card"),
        )  # fmt: skip
    elif event["kind"] == "crypto_send_succeeded":
        to = str((payload.get("request") or {}).get("toAddress", ""))
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="withdrawal", title=f"To {to[:6]}…{to[-4:]}", tag="Crypto", asset=payload["asset"], amount=-payload["amount"], channel="crypto"),
        )  # fmt: skip
    elif event["kind"] == "payout_succeeded":
        request = payload.get("request") or {}
        to = request.get("accountName") or f"•••• {str(request.get('accountNumber', ''))[-4:]}"
        await record(
            db,
            payload["entryId"],
            dict(user_id=user_id, kind="withdrawal", title=f"To {to}", tag="Withdrawal", asset=payload["asset"], amount=-payload["amount"], channel="bank"),
        )  # fmt: skip


async def apply_new_events() -> int:
    """Turns engine events the API hasn't seen into activity rows. Returns how many it applied."""
    async with sessionmaker()() as db:
        await db.execute(insert(EngineCursor).values(id=1, last_event_id=0).on_conflict_do_nothing())
        cursor = await db.scalar(select(EngineCursor).where(EngineCursor.id == 1).with_for_update())
        assert cursor is not None
        events = await engine.events_after(cursor.last_event_id)
        for event in events:
            await _apply(db, event)
            cursor.last_event_id = event["id"]
        await db.commit()
        return len(events)


async def follow_events(interval_s: float = 3) -> None:
    """Runs in the background for the API's lifetime."""
    while True:
        try:
            while await apply_new_events():
                pass
        except Exception:
            log.exception("applying engine events failed")
        await asyncio.sleep(interval_s)
