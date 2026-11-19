"""Phone-to-phone taps. The phone being paid is always the reader: a merchant's terminal (so it can
read bank cards too) or a person on Receive. The payer's phone (on Pay) presents itself as an NFC
tag carrying `tappi://tap/<token>`. The token names the payer and expires quickly. Reading it only
tells the payer's phone who they touched: it then opens the charge, or Send to that person, and
they still approve with their PIN."""

import base64
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import assert_own_receiving, now
from .db import PaymentRequest, PersonTap, User
from .errors import HttpError
from .security import hmac, safe_equal
from .wallet import display_name, needs_profile

TOKEN_TTL = timedelta(minutes=2)
# How long a tapped charge keeps popping up on the customer's phone.
TAP_WINDOW = timedelta(minutes=2)
NOT_A_PHONE = "That isn't a Tappi phone."


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _unb64(text: str) -> str:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode()


def _signature(payload: str) -> str:
    return hmac(f"tap:{payload}")[:24]


def issue_tap_token(user: User) -> dict[str, Any]:
    if user.status in ("deleting", "closed"):
        raise HttpError(403, "This account is being deleted.")
    expires_at = now() + TOKEN_TTL
    payload = f"{user.id}.{int(expires_at.timestamp())}"
    token = f"{_b64(payload)}.{_signature(payload)}"
    return {"token": token, "link": f"tappi://tap/{token}", "expiresAt": expires_at.isoformat()}


def read_tap_token(token: str) -> UUID:
    encoded, _, signature = token.partition(".")
    try:
        payload = _unb64(encoded)
        user_id, exp = payload.split(".")
        parsed = UUID(user_id)
        expires = int(exp)
    except ValueError:
        raise HttpError(400, NOT_A_PHONE) from None
    if not signature or not safe_equal(signature, _signature(payload)):
        raise HttpError(400, NOT_A_PHONE)
    if expires < now().timestamp():
        raise HttpError(410, "That phone needs to reopen Pay in Tappi, then tap again.")
    return parsed


async def _active(db: AsyncSession, user_id: UUID) -> User:
    user = await db.get(User, user_id)
    if user is None or user.status in ("deleting", "closed"):
        raise HttpError(404, "That Tappi account is no longer active.")
    return user


async def claim_tap(db: AsyncSession, merchant: User, request_id: str, token: str) -> dict[str, Any]:
    """The merchant's phone read a customer's phone: attach them to the open charge."""
    customer_id = read_tap_token(token)
    if customer_id == merchant.id:
        raise HttpError(400, "That's your own phone. Tap the customer's phone instead.")
    customer = await _active(db, customer_id)
    try:
        charge_id = UUID(request_id)
    except ValueError:
        raise HttpError(404, "No payment found for that code.") from None
    claimed = await db.scalar(
        update(PaymentRequest)
        .where(
            PaymentRequest.id == charge_id,
            PaymentRequest.merchant_id == merchant.id,
            PaymentRequest.status == "pending",
            PaymentRequest.expires_at > now(),
        )
        .values(tapped_by=customer.id, tapped_at=now())
        .returning(PaymentRequest.id)
    )
    await db.commit()
    if claimed is None:
        raise HttpError(409, "This charge is no longer open.")
    return {"customer": display_name(customer)}


async def claim_person_tap(db: AsyncSession, payee: User, token: str) -> dict[str, Any]:
    """A person on Receive read the payer's phone: the payer's Pay screen opens Send to them."""
    payer_id = read_tap_token(token)
    if payer_id == payee.id:
        raise HttpError(400, "That's your own phone.")
    assert_own_receiving(payee)
    if needs_profile(payee):
        raise HttpError(409, "Finish your profile to receive money.")
    payer = await _active(db, payer_id)
    db.add(PersonTap(payer_id=payer.id, payee_id=payee.id))
    await db.commit()
    return {"payer": display_name(payer)}


async def pending_tap(db: AsyncSession, user: User, since: datetime) -> dict[str, Any]:
    """The payer's phone polls this while presenting itself: what a payee's phone just read it
    into (a merchant's charge, or a person to send to). The newer one wins."""
    current = now()
    after = max(since - timedelta(seconds=5), current - TAP_WINDOW)  # 5 s for clock drift
    charge = await db.scalar(
        select(PaymentRequest)
        .where(
            PaymentRequest.tapped_by == user.id,
            PaymentRequest.status == "pending",
            PaymentRequest.expires_at > current,
            PaymentRequest.tapped_at > after,
        )
        .order_by(PaymentRequest.tapped_at.desc())
        .limit(1)
    )
    person = await db.scalar(
        select(PersonTap)
        .where(PersonTap.payer_id == user.id, PersonTap.created_at > after)
        .order_by(PersonTap.created_at.desc())
        .limit(1)
    )
    payee = await db.get(User, person.payee_id) if person else None
    person_newer = bool(
        person
        and payee
        and payee.handle
        and (charge is None or not charge.tapped_at or person.created_at > charge.tapped_at)
    )
    return {
        "charge": {"code": charge.code} if charge and not person_newer else None,
        "person": {"handle": payee.handle, "name": display_name(payee), "gender": payee.gender}
        if person_newer and payee
        else None,
    }
