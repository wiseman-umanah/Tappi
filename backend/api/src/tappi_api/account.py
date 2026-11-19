"""Account lifecycle

disable  → incoming money stops (sends, charges, deposits). The user can still sign in, spend and
           move their balance out, and turn it back on any time.
delete   → status `deleting`: signed out everywhere, open charges cancelled, @handle and balance
           kept. Signing in within the restore window offers "Restore my account".
close    → after the window: name, email, handle and PIN are erased and the engine sweeps the
           balance to Tappi's closed-accounts books. The activity feed stays, tied to an anonymous
           user row and an email HMAC, until `retain_until`. The same email can then sign up
           again as a brand-new account with no history.
erase    → after RETENTION_YEARS the user row and its feed are deleted. The engine's ledger keeps
           its own records.
"""

import asyncio
import logging
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import engine
from .auth import now
from .db import AiConversation, Card, NearbyBeacon, PaymentRequest, PersonTap, Session, User, sessionmaker
from .errors import HttpError
from .security import hmac
from .settings import settings
from .wallet import record

log = logging.getLogger("tappi")

# CBN AML/CFT Regulations 2022: keep records at least 5 years after the relationship ends.
RETENTION_YEARS = 5


def restore_window() -> timedelta:
    return timedelta(days=settings().account_restore_days)


async def set_receiving(db: AsyncSession, user: User, enabled: bool) -> User:
    if user.status not in ("active", "disabled"):
        raise HttpError(409, "This account is being deleted.")
    user.status = "active" if enabled else "disabled"
    await db.commit()
    return user


async def delete_account(db: AsyncSession, user: User) -> dict[str, Any]:
    delete_after = now() + restore_window()
    user.status = "deleting"
    user.delete_after = delete_after
    await db.execute(
        update(PaymentRequest)
        .where(PaymentRequest.merchant_id == user.id, PaymentRequest.status == "pending")
        .values(status="cancelled")
    )
    await db.execute(delete(Session).where(Session.user_id == user.id))
    await db.execute(delete(NearbyBeacon).where(NearbyBeacon.user_id == user.id))
    await db.commit()
    return {"deleteAfter": delete_after.isoformat()}


async def restore_account(db: AsyncSession, user: User) -> User:
    if user.status != "deleting":
        raise HttpError(409, "This account is not being deleted.")
    if not user.delete_after or user.delete_after < now():
        raise HttpError(410, "The restore window has ended. Sign in again to start a new account.")
    user.status = "active"
    user.delete_after = None
    await db.commit()
    return user


async def close_account(db: AsyncSession, user: User) -> bool:
    """End of the restore window: sweep the balance, erase personal data, keep the feed. Returns
    False when another request is already closing this account."""
    original_delete_after = user.delete_after
    # Claim it first (clearing delete_after) so a sign-in and the purge can't both close it.
    claimed = await db.scalar(
        update(User)
        .where(User.id == user.id, User.status == "deleting", User.delete_after.is_not(None))
        .values(delete_after=None)
        .returning(User.id)
    )
    await db.commit()
    if claimed is None:
        return False
    try:
        swept = await engine.close_account(user.id)
    except Exception:
        await db.execute(update(User).where(User.id == user.id).values(delete_after=original_delete_after))
        await db.commit()
        raise
    if swept:
        rows = [p for p in swept["postings"] if p["owner_type"] == "user"]
        await record(
            db,
            swept["id"],
            *(
                dict(
                    user_id=user.id,
                    kind="closure",
                    title="Account closed",
                    tag="Closure",
                    asset=p["asset"],
                    amount=p["amount"],
                )
                for p in rows
            ),
        )

    closed_at = now()
    await db.execute(delete(Session).where(Session.user_id == user.id))
    # Tappi AI chats are personal data, not ledger.
    await db.execute(delete(AiConversation).where(AiConversation.user_id == user.id))
    await db.execute(delete(Card).where(Card.user_id == user.id))
    await db.execute(delete(NearbyBeacon).where(NearbyBeacon.user_id == user.id))
    await db.execute(delete(PersonTap).where(or_(PersonTap.payer_id == user.id, PersonTap.payee_id == user.id)))
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            status="closed",
            email_hash=hmac(f"email:{user.email}") if user.email else user.email_hash,
            email=None,
            name=None,
            handle=None,
            gender=None,
            pin_hash=None,
            delete_after=None,
            closed_at=closed_at,
            retain_until=closed_at.replace(year=closed_at.year + RETENTION_YEARS),
        )
    )
    await db.commit()
    return True


async def close_expired_account(db: AsyncSession, user: User) -> None:
    """For sign-in: closes an account past its window, or waits while another request does."""
    if await close_account(db, user):
        return
    for _ in range(30):
        await db.refresh(user)
        if user.status == "closed":
            return
        await asyncio.sleep(0.5)
    raise HttpError(503, "Your old account is still being closed. Try again in a minute.")


async def purge_accounts() -> dict[str, int]:
    """Closes accounts whose restore window ended and erases closed accounts past retention."""
    closed = 0
    async with sessionmaker()() as db:
        due = (await db.scalars(select(User).where(User.status == "deleting", User.delete_after < now()))).all()
        for user in due:
            try:
                if await close_account(db, user):
                    closed += 1
            except Exception:
                log.exception("closing account %s failed", user.id)
        erased = await db.scalars(
            delete(User).where(User.status == "closed", User.retain_until < now()).returning(User.id)
        )
        count = len(erased.all())
        await db.commit()
    return {"closed": closed, "erased": count}


async def purge_forever(interval_s: int) -> None:
    """Runs the purge in the background (the API is one long-running process on our server)."""
    while True:
        try:
            result = await purge_accounts()
            if any(result.values()):
                log.info("account purge: %s", result)
        except Exception:
            log.exception("account purge failed")
        await asyncio.sleep(interval_s)


def purge_main() -> None:
    """`uv run tappi-purge`: run the purge once (e.g. from cron)."""
    logging.basicConfig(level=logging.INFO)

    async def run() -> None:
        try:
            print(await purge_accounts())
        finally:
            await engine.close()

    asyncio.run(run())
