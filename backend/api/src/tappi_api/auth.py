import logging
from datetime import UTC, datetime, timedelta
from math import ceil
from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .db import LoginCode, Session, User, get_db
from .errors import HttpError
from .security import hash_pin, hmac, pin_matches, random_code, random_token, safe_equal
from .settings import settings

log = logging.getLogger("tappi")

CODE_TTL = timedelta(minutes=10)
CODE_MAX_ATTEMPTS = 5
SESSION_TTL = timedelta(days=30)
PIN_MAX_FAILURES = 5
PIN_LOCK = timedelta(minutes=5)

Db = Annotated[AsyncSession, Depends(get_db)]


def now() -> datetime:
    return datetime.now(UTC)


async def request_code(db: AsyncSession, email: str) -> dict:
    code = random_code()
    code_hash = hmac(f"{email}:{code}")
    expires_at = now() + CODE_TTL
    await db.execute(
        insert(LoginCode)
        .values(email=email, code_hash=code_hash, expires_at=expires_at)
        .on_conflict_do_update(
            index_elements=[LoginCode.email],
            set_={"code_hash": code_hash, "attempts": 0, "expires_at": expires_at},
        )
    )
    await db.commit()
    log.info("login code for %s: %s", email, code)
    return {"sent": True, "devCode": code if settings().tappi_auto_code else None}


async def verify_code(db: AsyncSession, email: str, code: str) -> tuple[str, User]:
    """Checks the code, creates the user on first sign-in, and returns a new session token."""
    row = await db.get(LoginCode, email)
    if row is None or row.expires_at < now():
        raise HttpError(400, "That code has expired. Request a new one.")
    if row.attempts >= CODE_MAX_ATTEMPTS:
        raise HttpError(429, "Too many attempts. Request a new code.")
    if not safe_equal(row.code_hash, hmac(f"{email}:{code}")):
        row.attempts += 1
        await db.commit()
        raise HttpError(400, "That code isn't right.")
    await db.delete(row)
    await db.commit()

    # Back after the restore window but before the purge ran: close the old account first, so this
    # sign-in starts a brand-new one. Within the window the old account signs in to be restored.
    existing = await db.scalar(select(User).where(User.email == email))
    if existing and existing.status == "deleting" and (not existing.delete_after or existing.delete_after < now()):
        from .account import close_expired_account

        await close_expired_account(db, existing)

    user_id = await db.scalar(
        insert(User)
        .values(email=email)
        .on_conflict_do_update(index_elements=[User.email], set_={"email": email})
        .returning(User.id)
    )
    token = random_token()
    db.add(Session(token_hash=hmac(token), user_id=user_id, expires_at=now() + SESSION_TTL))
    await db.commit()
    user = await db.get(User, user_id)
    assert user is not None
    return token, user


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        return authorization.removeprefix("Bearer ").strip() or None
    return None


async def authenticate(db: AsyncSession, authorization: str | None) -> User | None:
    token = _bearer(authorization)
    if token is None:
        return None
    user_id = await db.scalar(
        select(Session.user_id).where(Session.token_hash == hmac(token), Session.expires_at > now())
    )
    return await db.get(User, user_id) if user_id else None


async def sign_out(db: AsyncSession, authorization: str | None) -> None:
    if token := _bearer(authorization):
        await db.execute(delete(Session).where(Session.token_hash == hmac(token)))
        await db.commit()


# Declared as a Bearer scheme so the API docs (/docs) get an "Authorize" button. auto_error=False:
# a missing token gets our own 401 message, not FastAPI's.
bearer = HTTPBearer(auto_error=False, description="The `token` from POST /api/auth/verify.")
Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]


def authorization_header(credentials: HTTPAuthorizationCredentials | None) -> str | None:
    return f"Bearer {credentials.credentials}" if credentials else None


async def _signed_in(db: Db, credentials: Credentials) -> User:
    user = await authenticate(db, authorization_header(credentials))
    if user is None or user.status == "closed":
        raise HttpError(401, "Please sign in again.")
    return user


async def require_user(user: Annotated[User, Depends(_signed_in)]) -> User:
    """The signed-in user. An account waiting to be deleted can only read /me and restore itself."""
    if user.status == "deleting":
        raise HttpError(403, "This account is being deleted. Restore it to continue.")
    return user


CurrentUser = Annotated[User, Depends(require_user)]
RestoringUser = Annotated[User, Depends(_signed_in)]


# ---- Transaction PIN (scrypt, per-user salt, locks after repeated failures) ----


async def set_pin(db: AsyncSession, user: User, pin: str) -> None:
    await db.execute(
        update(User).where(User.id == user.id).values(pin_hash=hash_pin(pin), pin_failures=0, pin_locked_until=None)
    )
    await db.commit()


async def verify_pin(db: AsyncSession, user: User, pin: str) -> None:
    """Raises unless `pin` is the user's PIN. Every money-moving route calls this first."""
    if not user.pin_hash:
        raise HttpError(400, "Set a transaction PIN first.")
    if user.pin_locked_until and user.pin_locked_until > now():
        minutes = ceil((user.pin_locked_until - now()).total_seconds() / 60)
        raise HttpError(429, f"Too many wrong PINs. Try again in {minutes} min.")
    if not pin_matches(pin, user.pin_hash):
        failures = user.pin_failures + 1
        locked = failures >= PIN_MAX_FAILURES
        user.pin_failures = 0 if locked else failures
        user.pin_locked_until = now() + PIN_LOCK if locked else None
        await db.commit()
        raise HttpError(
            400,
            "Too many wrong PINs. Try again in 5 min."
            if locked
            else f"Wrong PIN. {PIN_MAX_FAILURES - failures} tries left.",
        )
    if user.pin_failures:
        user.pin_failures = 0
        await db.commit()


# ---- Account status ----


def assert_can_receive(user: User, who: str) -> None:
    """Raises unless money can be sent to `user` (a disabled or deleted account takes nothing in)."""
    if user.status == "active":
        return
    if user.status == "disabled":
        raise HttpError(403, f"{who} isn't accepting payments right now.")
    raise HttpError(403, f"{who} is no longer on Tappi.")


def assert_own_receiving(user: User) -> None:
    """For the user's own incoming money: Terminal charges and test deposits."""
    if user.status == "disabled":
        raise HttpError(403, "Your account is disabled. Turn it back on in Profile to receive money.")
