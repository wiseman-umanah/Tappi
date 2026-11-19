from math import ceil
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from . import engine
from .auth import assert_can_receive, now
from .db import Entry, User
from .errors import HttpError
from .handles import HANDLE_PATTERN, is_handle_taken, normalize_handle
from .money import ASSETS, to_major
from .settings import settings


def display_name(u: User) -> str:
    return u.name or (f"@{u.handle}" if u.handle else (u.email or "Former Tappi user"))


def public_user(u: User) -> dict[str, Any]:
    return {
        "id": str(u.id),
        "email": u.email,
        "name": u.name,
        "handle": u.handle,
        "gender": u.gender,
        "language": u.language,
    }


def needs_profile(u: User) -> bool:
    return not u.handle or not u.gender


async def record(db: AsyncSession, ledger_entry_id: str, *rows: dict[str, Any]) -> None:
    """Adds the activity rows for one engine entry. Safe to repeat: a retried request whose money
    already moved (the engine replays it) fills in whatever rows are missing."""
    for row in rows:
        await db.execute(
            insert(Entry)
            .values(ledger_entry_id=UUID(ledger_entry_id), **row)
            .on_conflict_do_nothing(index_elements=[Entry.ledger_entry_id, Entry.user_id, Entry.asset])
        )
    await db.commit()


# ---------------- Profile ----------------


async def me(user: User) -> dict[str, Any]:
    balances = None if needs_profile(user) else await engine.balances(user.id)
    days_left = max(1, ceil((user.delete_after - now()).total_seconds() / 86_400)) if user.delete_after else None
    return {
        "user": public_user(user),
        "needsProfile": needs_profile(user),
        "hasPin": bool(user.pin_hash),
        "account": {
            "status": user.status,
            "deleteAfter": user.delete_after.isoformat() if user.delete_after else None,
            "daysLeft": days_left,
            "restoreDays": settings().account_restore_days,
        },
        "wallet": {"balances": {a: to_major(a, balances.get(a, 0)) for a in ASSETS}} if balances is not None else None,
    }


async def update_profile(db: AsyncSession, user: User, changes: dict[str, Any]) -> User:
    if (handle := changes.get("handle")) and await is_handle_taken(db, handle, user.id):
        raise HttpError(409, f"@{handle} is taken. Try another username.")
    for field, value in changes.items():
        setattr(user, field, value)
    await db.commit()

    return user


async def find_by_handle(db: AsyncSession, raw: str) -> User | None:
    handle = normalize_handle(raw)
    if not HANDLE_PATTERN.match(handle):
        return None
    return await db.scalar(select(User).where(User.handle == handle))


async def lookup_handle(db: AsyncSession, raw: str) -> dict[str, Any]:
    handle = normalize_handle(raw)
    user = await find_by_handle(db, handle)
    if user is None or user.status in ("deleting", "closed") or needs_profile(user):
        raise HttpError(404, f"No Tappi user called @{handle}.")
    assert_can_receive(user, f"@{handle}")
    return {"name": display_name(user), "handle": user.handle, "gender": user.gender}


# ---------------- Send to a Tappi user ----------------


async def send(db: AsyncSession, user: User, to: str, asset: str, amount: int, request_key: str) -> dict[str, Any]:
    handle = normalize_handle(to)
    recipient = await find_by_handle(db, handle)
    if recipient is None or needs_profile(recipient):
        raise HttpError(404, f"No Tappi user called @{handle}.")
    if recipient.id == user.id:
        raise HttpError(400, "You can't send money to yourself.")
    assert_can_receive(recipient, f"@{handle}")

    result = await engine.transfer(
        key=f"send:{user.id}:{request_key}",
        kind="send",
        from_user=user.id,
        to_user=recipient.id,
        asset=asset,
        amount=amount,
        reference=f"@{recipient.handle}",
    )
    await record(
        db,
        result["id"],
        dict(
            user_id=user.id,
            kind="payment_out",
            title=display_name(recipient),
            tag="Transfer",
            asset=asset,
            amount=-amount,
            channel="send",
        ),
        dict(
            user_id=recipient.id,
            kind="payment_in",
            title=display_name(user),
            tag="Transfer",
            asset=asset,
            amount=amount,
            channel="send",
        ),
    )
    return {"to": display_name(recipient), "reference": result["id"]}


# ---------------- Activity ----------------


async def activity(db: AsyncSession, user: User) -> dict[str, Any]:
    rows = (
        await db.scalars(select(Entry).where(Entry.user_id == user.id).order_by(Entry.created_at.desc()).limit(100))
    ).all()

    # This month's spending by tag. Naira only until there's a live rate (Bitnob) to count the rest.
    month_start = now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    spent = [
        e for e in rows if e.kind in ("payment_out", "refund_in") and e.asset == "NGN" and e.created_at >= month_start
    ]
    by_tag: dict[str, float] = {}
    for e in spent:
        by_tag[e.tag] = by_tag.get(e.tag, 0) - to_major("NGN", e.amount)
    total = sum(by_tag.values())
    tags = [
        {"tag": tag, "amount": amount, "percent": round(amount / total * 100) if total else 0}
        for tag, amount in sorted(by_tag.items(), key=lambda kv: -kv[1])
        if amount > 0.5
    ]

    return {
        "entries": [
            {
                "id": str(e.id),
                "kind": e.kind,
                "title": e.title,
                "tag": e.tag,
                "asset": e.asset,
                "amount": to_major(e.asset, e.amount),
                "assetIn": e.asset_in,
                "amountIn": to_major(e.asset_in, e.amount_in) if e.asset_in and e.amount_in is not None else None,
                "channel": e.channel,
                "at": e.created_at.isoformat(),
                "reference": str(e.ledger_entry_id),
            }
            for e in rows
        ],
        "spending": {"total": total, "payments": sum(1 for e in spent if e.kind == "payment_out"), "tags": tags},
    }
