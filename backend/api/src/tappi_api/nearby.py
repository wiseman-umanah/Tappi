"""'Who's around': phones in tap mode (Receive, or a merchant with a charge open) announce a random
Bluetooth beacon id (modules/tappi-nearby in the app). Payers' phones hear the ids and ask here who
they are. Ids live a few minutes and are replaced while the screen stays open, so an id overheard
later says nothing. Only people who opened Receive (or a charge) can be found."""

import re
import secrets
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import assert_own_receiving, now
from .db import NearbyBeacon, PaymentRequest, User
from .errors import HttpError
from .money import to_major
from .wallet import display_name, needs_profile

BEACON_TTL = timedelta(minutes=3)
MAX_IDS = 30
BEACON_ID = re.compile(r"^[0-9a-f]{16}$")


async def issue_beacon(db: AsyncSession, user: User, request_id: UUID | None) -> dict[str, Any]:
    """Start (or renew) this phone's beacon. With `request_id`, the merchant's open charge is announced."""
    assert_own_receiving(user)
    if needs_profile(user):
        raise HttpError(409, "Finish your profile to receive money.")
    if request_id:
        charge = await db.scalar(
            select(PaymentRequest.id).where(
                PaymentRequest.id == request_id,
                PaymentRequest.merchant_id == user.id,
                PaymentRequest.status == "pending",
            )
        )
        if charge is None:
            raise HttpError(409, "This charge is no longer open.")
    # One beacon per user; old ones (and anyone's expired ones) go.
    await db.execute(delete(NearbyBeacon).where(NearbyBeacon.user_id == user.id))
    await db.execute(delete(NearbyBeacon).where(NearbyBeacon.expires_at < now()))
    beacon = NearbyBeacon(
        id=secrets.token_hex(8), user_id=user.id, request_id=request_id, expires_at=now() + BEACON_TTL
    )
    db.add(beacon)
    await db.commit()
    return {"id": beacon.id, "expiresAt": beacon.expires_at.isoformat()}


async def end_beacon(db: AsyncSession, user: User) -> dict[str, Any]:
    await db.execute(delete(NearbyBeacon).where(NearbyBeacon.user_id == user.id))
    await db.commit()
    return {"ok": True}


async def resolve_beacons(db: AsyncSession, viewer: User, ids: list[str]) -> dict[str, Any]:
    """The people and merchants behind beacon ids this phone heard. Unknown or expired ids are left out."""
    wanted = [i for i in dict.fromkeys(i.lower() for i in ids) if BEACON_ID.match(i)][:MAX_IDS]
    if not wanted:
        return {"nearby": []}
    current = now()
    beacons = (
        await db.scalars(
            select(NearbyBeacon).where(
                NearbyBeacon.id.in_(wanted), NearbyBeacon.expires_at > current, NearbyBeacon.user_id != viewer.id
            )
        )
    ).all()
    if not beacons:
        return {"nearby": []}
    people = {u.id: u for u in await db.scalars(select(User).where(User.id.in_({b.user_id for b in beacons})))}
    request_ids = {b.request_id for b in beacons if b.request_id}
    charges = (
        {
            c.id: c
            for c in await db.scalars(
                select(PaymentRequest).where(
                    PaymentRequest.id.in_(request_ids),
                    PaymentRequest.status == "pending",
                    PaymentRequest.expires_at > current,
                )
            )
        }
        if request_ids
        else {}
    )

    nearby = []
    for b in beacons:
        person = people.get(b.user_id)
        # Only accounts that can take money in show up.
        if person is None or not person.handle or person.status != "active":
            continue
        who = {"beacon": b.id, "name": display_name(person), "handle": person.handle, "gender": person.gender}
        if b.request_id is None:
            nearby.append({"kind": "person", **who, "charge": None})
        elif charge := charges.get(b.request_id):
            nearby.append(
                {
                    "kind": "merchant",
                    **who,
                    # The open charge picking them pays.
                    "charge": {
                        "code": charge.code,
                        "amount": to_major(charge.asset, charge.amount),
                        "asset": charge.asset,
                        "tag": charge.tag,
                    },
                }
            )
    return {"nearby": nearby}
