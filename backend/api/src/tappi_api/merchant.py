import re
import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import engine
from .auth import assert_can_receive, assert_own_receiving, now
from .db import PaymentRequest, User
from .engine import InsufficientFunds
from .errors import HttpError
from .money import to_major
from .settings import settings
from .wallet import display_name, record

REQUEST_TTL = timedelta(minutes=5)
# No 0/O/1/I so the code is easy to read out and type.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
# What a merchant can charge in. Customers pay in the same currency (no swap mid-payment).
CHARGE_ASSETS = ("NGN", "USDC")
# Card brands the merchant's reader recognises (from the card's payment application ID).
CARD_BRANDS = ("Visa", "Mastercard", "Verve", "American Express", "Discover", "UnionPay", "JCB", "Card")
STATUS_LABEL = {"paid": "Completed", "refunded": "Refunded", "cancelled": "Failed", "expired": "Failed"}
NOT_OPEN = "This charge is no longer open."


def state_of(r: PaymentRequest) -> str:
    return "expired" if r.status == "pending" and r.expires_at < now() else r.status


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


def present(r: PaymentRequest, merchant: User, tapped_by: User | None = None) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "code": r.code,
        "amount": to_major(r.asset, r.amount),
        # The currency charged (and received by the merchant).
        "asset": r.asset,
        "tag": r.tag,
        "state": state_of(r),
        "expiresAt": r.expires_at.isoformat(),
        # What the merchant's QR code carries.
        "link": f"tappi://pay/{r.code}",
        "merchant": {"name": display_name(merchant), "handle": merchant.handle, "gender": merchant.gender},
        # Merchant only: the customer whose phone was tapped, while they approve with their PIN.
        "tapped": display_name(tapped_by) if tapped_by else None,
        "channel": r.channel,
        "cardBrand": r.card_brand,
        "reference": str(r.ledger_entry_id) if r.ledger_entry_id else None,
    }


async def create_request(db: AsyncSession, merchant: User, amount: int, tag: str, asset: str) -> dict[str, Any]:
    assert_own_receiving(merchant)
    row = PaymentRequest(
        code=_new_code(), merchant_id=merchant.id, amount=amount, asset=asset, tag=tag, expires_at=now() + REQUEST_TTL
    )
    db.add(row)
    await db.commit()
    return present(row, merchant)


async def _find(db: AsyncSession, id_or_code: str) -> PaymentRequest:
    if re.fullmatch(r"[0-9a-fA-F-]{36}", id_or_code):
        row = await db.get(PaymentRequest, UUID(id_or_code))
    else:
        row = await db.scalar(select(PaymentRequest).where(PaymentRequest.code == id_or_code.upper()))
    if row is None:
        raise HttpError(404, "No payment found for that code.")
    return row


async def get_request(db: AsyncSession, viewer: User, id_or_code: str) -> dict[str, Any]:
    row = await _find(db, id_or_code)
    merchant = await db.get(User, row.merchant_id)
    assert merchant is not None
    tapped_by = (
        await db.get(User, row.tapped_by)
        if viewer.id == row.merchant_id and row.tapped_by and row.status == "pending"
        else None
    )
    return present(row, merchant, tapped_by)


async def _claim(db: AsyncSession, row_id: UUID, from_status: str, **values: Any) -> PaymentRequest | None:
    """Moves a charge out of `from_status` atomically, so two phones can't both pay (or refund) it."""
    conditions = [PaymentRequest.id == row_id, PaymentRequest.status == from_status]
    if from_status == "pending":
        conditions.append(PaymentRequest.expires_at > now())
    claimed = await db.scalar(update(PaymentRequest).where(*conditions).values(**values).returning(PaymentRequest))
    await db.commit()
    return claimed


async def _unclaim(db: AsyncSession, row_id: UUID, **values: Any) -> None:
    await db.execute(update(PaymentRequest).where(PaymentRequest.id == row_id).values(**values))
    await db.commit()


async def pay_request(db: AsyncSession, payer: User, id_or_code: str, pay_asset: str | None, channel: str) -> dict:
    """The customer pays a pending charge. The merchant receives exactly what they charged."""
    row = await _find(db, id_or_code)
    if row.merchant_id == payer.id:
        raise HttpError(400, "You can't pay your own charge.")
    state = state_of(row)
    if state != "pending":
        raise HttpError(409, "This charge has expired." if state == "expired" else NOT_OPEN)
    pay_asset = pay_asset or row.asset
    if pay_asset != row.asset:
        raise HttpError(400, f"This charge is in {row.asset}. Swap to {row.asset} first, then pay.")
    merchant = await db.get(User, row.merchant_id)
    if merchant is None:
        raise HttpError(403, "This merchant is no longer on Tappi.")
    assert_can_receive(merchant, "This merchant")

    claimed = await _claim(
        db, row.id, "pending", status="paid", payer_id=payer.id, pay_asset=pay_asset, channel=channel, paid_at=now()
    )
    if claimed is None:
        raise HttpError(409, NOT_OPEN)
    try:
        result = await engine.transfer(
            key=f"charge:{row.id}:pay",
            kind="payment",
            from_user=payer.id,
            to_user=merchant.id,
            asset=row.asset,
            amount=row.amount,
            reference=f"charge:{row.code}",
        )
    except HttpError as error:
        await _unclaim(db, row.id, status="pending", payer_id=None, pay_asset=None, channel=None, paid_at=None)
        # A different payer's earlier attempt holds this charge's ledger key.
        raise (HttpError(409, NOT_OPEN) if error.status == 409 else error) from None

    await _unclaim(db, row.id, ledger_entry_id=UUID(result["id"]))
    await record(
        db,
        result["id"],
        dict(user_id=payer.id, kind="payment_out", title=display_name(merchant), tag=row.tag, asset=row.asset, amount=-row.amount, channel=channel, request_id=row.id),
        dict(user_id=merchant.id, kind="payment_in", title=display_name(payer), tag=row.tag, asset=row.asset, amount=row.amount, channel=channel, request_id=row.id),
    )  # fmt: skip
    amount = to_major(row.asset, row.amount)
    return {
        "reference": result["id"],
        "amount": amount,
        "asset": row.asset,
        "spent": amount,
        "payAsset": pay_asset,
        "merchant": display_name(merchant),
    }


async def pay_by_card(db: AsyncSession, merchant: User, request_id: str, brand: str) -> dict[str, Any]:
    """A bank card tapped the merchant's phone. Reading the card works; charging it needs a card
    acquirer, and neither Paga nor Bitnob is one, so it's refused clearly instead of faked."""
    raise HttpError(
        409, f"{brand} card payments need a card acquirer. They aren't available yet: ask for Tappi Pay or a QR code."
    )


async def cancel_request(db: AsyncSession, merchant: User, request_id: str) -> None:
    row = await _find(db, request_id)
    if row.merchant_id == merchant.id:
        await db.execute(
            update(PaymentRequest)
            .where(PaymentRequest.id == row.id, PaymentRequest.status == "pending")
            .values(status="cancelled")
        )
        await db.commit()


async def refund(db: AsyncSession, merchant: User, request_id: str) -> dict[str, Any]:
    """Sends a completed payment back to the customer, in the currency it was charged in."""
    row = await _find(db, request_id)
    if row.merchant_id != merchant.id:
        raise HttpError(404, "No payment found for that code.")
    if row.channel == "card" and row.status == "paid":
        raise HttpError(409, "Card payments are refunded to the card by the bank. That needs a card acquirer.")
    if row.status != "paid" or row.payer_id is None:
        raise HttpError(409, "Only completed payments can be refunded.")
    # Refunds return the customer's own money, so a disabled account still gets them back.
    customer = await db.get(User, row.payer_id)
    if customer is None or customer.status == "closed":
        raise HttpError(409, "This customer has left Tappi, so it can't be refunded.")

    if await _claim(db, row.id, "paid", status="refunded") is None:
        raise HttpError(409, "Only completed payments can be refunded.")
    try:
        result = await engine.transfer(
            key=f"charge:{row.id}:refund",
            kind="refund",
            from_user=merchant.id,
            to_user=customer.id,
            asset=row.asset,
            amount=row.amount,
            reference=f"charge:{row.code}",
        )
    except InsufficientFunds:
        await _unclaim(db, row.id, status="paid")
        raise HttpError(400, "Not enough balance to refund this payment.") from None
    except HttpError:
        await _unclaim(db, row.id, status="paid")
        raise
    await _unclaim(db, row.id, refund_entry_id=UUID(result["id"]))
    await record(
        db,
        result["id"],
        dict(user_id=merchant.id, kind="refund_out", title=f"Refund to {display_name(customer)}", tag=row.tag, asset=row.asset, amount=-row.amount, request_id=row.id),
        dict(user_id=customer.id, kind="refund_in", title=f"Refund from {display_name(merchant)}", tag=row.tag, asset=row.asset, amount=row.amount, request_id=row.id),
    )  # fmt: skip
    return {"reference": result["id"]}


# ---------------- Merchant dashboard ----------------


def _in_naira(r: PaymentRequest) -> float:
    """Display only: dollar sales count at the indicative rate."""
    amount = to_major(r.asset, r.amount)
    return amount if r.asset == "NGN" else amount * settings().ngn_per_usd


async def dashboard(db: AsyncSession, merchant: User) -> dict[str, Any]:
    rows = (
        await db.scalars(
            select(PaymentRequest)
            .where(PaymentRequest.merchant_id == merchant.id)
            .order_by(PaymentRequest.created_at.desc())
            .limit(100)
        )
    ).all()
    payer_ids = {r.payer_id for r in rows if r.payer_id}
    payers = (await db.scalars(select(User).where(User.id.in_(payer_ids)))).all() if payer_ids else []
    payer_name = {p.id: display_name(p) for p in payers}

    def payer_label(r: PaymentRequest, state: str) -> str:
        if r.payer_id:
            return payer_name.get(r.payer_id, "Tappi user")
        if r.card_brand:
            return f"{r.card_brand} card"
        return "Cancelled" if state == "cancelled" else "Not paid"

    payments = [
        {
            "id": str(r.id),
            "amount": to_major(r.asset, r.amount),
            "asset": r.asset,
            "tag": r.tag,
            "status": STATUS_LABEL[state],
            "payer": payer_label(r, state),
            "channel": r.channel,
            "at": (r.paid_at or r.created_at).isoformat(),
            "reference": str(r.ledger_entry_id) if r.ledger_entry_id else None,
        }
        for r in rows
        if (state := state_of(r)) != "pending"
    ]

    tz = ZoneInfo(settings().timezone)
    today = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today - timedelta(days=6)
    week = (
        await db.scalars(
            select(PaymentRequest).where(
                PaymentRequest.merchant_id == merchant.id,
                PaymentRequest.status == "paid",
                PaymentRequest.paid_at >= week_start,
            )
        )
    ).all()
    completed_today = [r for r in week if r.paid_at and r.paid_at >= today]
    weekly = []
    for i in range(7):
        day = week_start + timedelta(days=i)
        amount = sum(_in_naira(r) for r in week if r.paid_at and day <= r.paid_at < day + timedelta(days=1))
        weekly.append({"day": "Today" if i == 6 else day.strftime("%a"), "amount": amount})

    return {
        "payments": payments,
        # Naira, with dollar sales at the indicative rate.
        "todayVolume": sum(_in_naira(r) for r in completed_today),
        "todayUsdc": sum(to_major(r.asset, r.amount) for r in completed_today if r.asset == "USDC"),
        "todayTaps": len(completed_today),
        # What the merchant can withdraw to a bank right now (their naira balance).
        "payoutBalance": to_major("NGN", (await engine.balances(merchant.id)).get("NGN", 0)),
        "weekly": weekly,
    }
