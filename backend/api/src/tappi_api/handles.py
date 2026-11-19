import re
import secrets
import unicodedata

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import User

HANDLE_PATTERN = re.compile(r"^[a-z0-9_]{3,20}$")
RESERVED = {
    "tappi", "admin", "support", "help", "merchant", "official", "team", "security",
    "billing", "payments", "pay", "settings", "system", "root", "me",
}  # fmt: skip


def normalize_handle(raw: str) -> str:
    return raw.strip().removeprefix("@").lower()


async def _taken(db: AsyncSession, candidates: list[str], self_id) -> set[str]:
    """Handles from `candidates` someone else holds (a deleting account keeps its handle until closed)."""
    if not candidates:
        return set()
    rows = await db.scalars(select(User.handle).where(User.handle.in_(candidates), User.id != self_id))
    return {h for h in rows if h} | {c for c in candidates if c in RESERVED}


async def is_handle_taken(db: AsyncSession, handle: str, self_id) -> bool:
    return handle in await _taken(db, [handle], self_id)


async def _suggest(db: AsyncSession, user: User, handle: str, name: str | None) -> list[str]:
    text = unicodedata.normalize("NFKD", (name or user.name or "").lower())
    words = re.sub(r"[^a-z\s]", "", text).split()
    first = words[0] if words else None
    last = words[-1] if len(words) > 1 else None
    base = (re.sub(r"_?\d+$", "", handle) or handle)[:15]
    # Alternate name-based and username-based ideas so the top three offer both.
    pool = [
        f"{first}{last}" if first and last else None,
        f"{base}{10 + secrets.randbelow(90)}",
        f"{first}_{last}" if first and last else None,
        f"{base}_ng",
        f"{first[0]}{last}" if first and last else None,
        f"the{base}",
        f"{base}{100 + secrets.randbelow(900)}",
    ]
    unique = list(dict.fromkeys(c for c in pool if c and HANDLE_PATTERN.match(c) and c != handle))
    held = await _taken(db, unique, user.id)
    return [c for c in unique if c not in held][:3]


async def check_handle(db: AsyncSession, user: User, raw: str, name: str | None) -> dict:
    """Live username check for the profile form, with suggestions when it's taken."""
    handle = normalize_handle(raw)
    if not HANDLE_PATTERN.match(handle):
        return {"handle": handle, "available": False, "message": "Use 3–20 letters, numbers or _", "suggestions": []}
    if not await is_handle_taken(db, handle, user.id):
        return {"handle": handle, "available": True, "message": f"@{handle} is available", "suggestions": []}
    return {
        "handle": handle,
        "available": False,
        "message": f"@{handle} is taken",
        "suggestions": await _suggest(db, user, handle, name),
    }
