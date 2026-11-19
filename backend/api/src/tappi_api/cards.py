"""The Tappi card. It spends inside Tappi like any Tappi payment, with card rules on top: freeze, a
daily limit, and which balance pays. Not a bank card: the Bitnob USD Visa card is a separate
product, coming later.

Tapping: the phone is the card. "Tap to pay" (after the phone's unlock, if the user wants that)
arms the card for a minute with a random single-use nonce; the phone presents
`tappi://card/<cardId>.<nonce>` over NFC; the merchant's charge screen reads it and the charge is
paid straight away. The unlock was the approval, like a contactless card or a phone wallet."""

import re
import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import now, verify_pin
from .db import Card, Entry, PaymentRequest, User
from .errors import HttpError
from .merchant import pay_request
from .money import to_major, to_minor
from .settings import settings
from .wallet import needs_profile

ARM = timedelta(seconds=60)
# Not a real card range: 88 is unassigned to payment networks.
TEST_PREFIX = "889912"
DAILY_LIMITS = (20_000, 50_000, 100_000, 200_000, 500_000)  # naira
CHANNEL = "tappi_card"


def _luhn_digit(partial: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(partial)):
        d = int(ch)
        if i % 2 == 0:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return str((10 - total % 10) % 10)


def _new_number() -> str:
    body = TEST_PREFIX + "".join(str(secrets.randbelow(10)) for _ in range(9))
    return body + _luhn_digit(body)


async def own_card(db: AsyncSession, user: User) -> Card:
    if needs_profile(user):
        raise HttpError(409, "Finish your profile to get your Tappi card.")
    existing = await db.scalar(select(Card).where(Card.user_id == user.id))
    if existing:
        return existing
    expiry = now()
    await db.execute(
        insert(Card)
        .values(
            user_id=user.id,
            number=_new_number(),
            exp_month=expiry.month,
            exp_year=expiry.year + 3,
            cvv=f"{secrets.randbelow(1000):03d}",
        )
        .on_conflict_do_nothing(index_elements=[Card.user_id])
    )
    await db.commit()
    # Created here, or by another request that won the race.
    card = await db.scalar(select(Card).where(Card.user_id == user.id))
    assert card is not None
    return card


def _naira(asset: str, minor: int) -> float:
    """Card limits are in naira; dollar spends count at the indicative rate."""
    amount = to_major(asset, minor)
    return amount if asset == "NGN" else amount * settings().ngn_per_usd


def _start_of_day() -> datetime:
    return datetime.now(ZoneInfo(settings().timezone)).replace(hour=0, minute=0, second=0, microsecond=0)


async def _spent_today(db: AsyncSession, user_id: UUID) -> float:
    """Today's card spending in naira."""
    rows = await db.execute(
        select(Entry.asset, func.sum(-Entry.amount))
        .where(
            Entry.user_id == user_id,
            Entry.kind == "payment_out",
            Entry.channel == CHANNEL,
            Entry.created_at >= _start_of_day(),
        )
        .group_by(Entry.asset)
    )
    return sum(_naira(asset, int(total)) for asset, total in rows)


def _expiry(card: Card) -> str:
    return f"{card.exp_month:02d}/{str(card.exp_year)[-2:]}"


async def get_card(db: AsyncSession, user: User) -> dict[str, Any]:
    """The card as the Cards screen shows it: number masked."""
    card = await own_card(db, user)
    armed = card.armed_until.isoformat() if card.armed_nonce and card.armed_until and card.armed_until > now() else None
    # The latest card payment from the last two minutes, so the screen can say it went through.
    last = await db.scalar(
        select(Entry)
        .where(
            Entry.user_id == user.id,
            Entry.channel == CHANNEL,
            Entry.kind == "payment_out",
            Entry.created_at > now() - timedelta(minutes=2),
        )
        .order_by(Entry.created_at.desc())
        .limit(1)
    )
    return {
        "last4": card.number[-4:],
        "expiry": _expiry(card),
        "holder": user.name or (f"@{user.handle}" if user.handle else "Tappi user"),
        "frozen": card.frozen,
        "dailyLimit": to_major("NGN", card.daily_limit),
        "fundingAsset": card.funding_asset,
        "spentToday": round(await _spent_today(db, user.id)),
        "limits": list(DAILY_LIMITS),
        "armedUntil": armed,
        "lastPayment": {
            "id": str(last.id),
            "merchant": last.title,
            "asset": last.asset,
            "amount": -to_major(last.asset, last.amount),
            "at": last.created_at.isoformat(),
        }
        if last
        else None,
    }


async def card_details(db: AsyncSession, user: User, pin: str) -> dict[str, Any]:
    """Full number, expiry and CVV: only after the PIN."""
    await verify_pin(db, user, pin)
    card = await own_card(db, user)
    return {"number": re.sub(r"(\d{4})(?=\d)", r"\1 ", card.number), "expiry": _expiry(card), "cvv": card.cvv}


async def update_card(db: AsyncSession, user: User, changes: dict[str, Any]) -> dict[str, Any]:
    card = await own_card(db, user)
    if "frozen" in changes:
        card.frozen = changes["frozen"]
        # Freezing also disarms a card that's waiting for a tap.
        if card.frozen:
            card.armed_nonce = card.armed_until = None
    if "dailyLimit" in changes:
        card.daily_limit = to_minor("NGN", changes["dailyLimit"])
    if "fundingAsset" in changes:
        card.funding_asset = changes["fundingAsset"]
    await db.commit()
    return await get_card(db, user)


async def arm_card(db: AsyncSession, user: User, pin: str | None) -> dict[str, Any]:
    """'Tap to pay': one merchant can read the card in the next minute. `pin` when the phone has no lock."""
    if pin:
        await verify_pin(db, user, pin)
    card = await own_card(db, user)
    if card.frozen:
        raise HttpError(409, "Your card is frozen. Unfreeze it to pay.")
    card.armed_nonce = secrets.token_urlsafe(16)
    card.armed_until = now() + ARM
    await db.commit()
    return {"link": f"tappi://card/{card.id}.{card.armed_nonce}", "armedUntil": card.armed_until.isoformat()}


async def disarm_card(db: AsyncSession, user: User) -> dict[str, Any]:
    await db.execute(update(Card).where(Card.user_id == user.id).values(armed_nonce=None, armed_until=None))
    await db.commit()
    return {"ok": True}


async def pay_with_card(db: AsyncSession, merchant: User, request_id: str, token: str) -> dict[str, Any]:
    """The merchant's phone read a Tappi card: pay the charge from the card holder's balance."""
    card_id, _, nonce = token.partition(".")
    try:
        card_uuid, charge_uuid = UUID(card_id), UUID(request_id)
    except ValueError:
        raise HttpError(400, "That isn't a Tappi card.") from None
    if not nonce:
        raise HttpError(400, "That isn't a Tappi card.")
    charge = await db.scalar(
        select(PaymentRequest).where(PaymentRequest.id == charge_uuid, PaymentRequest.merchant_id == merchant.id)
    )
    if charge is None:
        raise HttpError(404, "No such charge.")
    card = await db.get(Card, card_uuid)
    if card is None:
        raise HttpError(400, "That isn't a Tappi card.")
    # Checked before the tap is used up, so the customer can fix it and tap again without re-arming.
    if card.funding_asset != charge.asset:
        raise HttpError(
            409,
            f"That card pays from {card.funding_asset} and this charge is in {charge.asset}. "
            "They can switch the card's currency on the Cards screen, or pay with Pay.",
        )

    # Use the nonce up first: one tap pays once, even if it's read twice.
    used = await db.scalar(
        update(Card)
        .where(Card.id == card_uuid, Card.armed_nonce == nonce, Card.armed_until > now())
        .values(armed_nonce=None, armed_until=None)
        .returning(Card.id)
    )
    await db.commit()
    if used is None:
        raise HttpError(410, "That card tap ran out. Ask them to press Tap to pay again.")
    await db.refresh(card)
    if card.frozen:
        raise HttpError(409, "That card is frozen.")
    if card.user_id == merchant.id:
        raise HttpError(400, "That's your own card.")
    holder = await db.get(User, card.user_id)
    if holder is None or holder.status in ("deleting", "closed"):
        raise HttpError(404, "That card is no longer active.")
    if await _spent_today(db, holder.id) + _naira(charge.asset, charge.amount) > to_major("NGN", card.daily_limit):
        raise HttpError(402, "Over the card's daily limit. They can raise it on the Cards screen, or pay with Pay.")
    return await pay_request(db, holder, str(charge.id), card.funding_asset, CHANNEL)
