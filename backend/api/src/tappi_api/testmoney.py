"""`tappi-fund`: gives a user test money while Paga and Bitnob can't fund sandbox accounts yet.

    tappi-fund @ada NGN 50000
    tappi-fund ada@example.com USDC 25

Goes through the engine's test-only mint (the ledger stays balanced; the money comes from the
`sandbox_mint` system account), so it only works while the engine runs with ENGINE_SANDBOX=true.
The app can't reach this: it's a command for whoever runs the server. Test money can move between
Tappi users, but withdrawals and crypto sends of it are refused by the providers (Tappi doesn't hold
it there). Before real money: ENGINE_SANDBOX=false and a fresh database.
"""

import argparse
import asyncio
import secrets
import sys

from sqlalchemy import select

from . import engine
from .db import User, dispose, sessionmaker
from .errors import HttpError
from .money import ASSETS, to_minor
from .wallet import needs_profile, record


async def fund(who: str, asset: str, amount: str) -> str:
    async with sessionmaker()() as db:
        who = who.strip()
        query = (
            select(User).where(User.handle == who.removeprefix("@").lower())
            if who.startswith("@")
            else select(User).where(User.email == who.lower())
        )
        user = await db.scalar(query)
        if user is None:
            raise SystemExit(f"No user {who}.")
        if needs_profile(user):
            raise SystemExit(f"{who} hasn't finished their profile yet.")
        minor = to_minor(asset, amount)
        try:
            entry = await engine._call(
                "POST",
                "/v1/sandbox/credit",
                {
                    "idempotency_key": f"test-money:{secrets.token_hex(8)}",
                    "owner_id": str(user.id),
                    "asset": asset,
                    "amount": minor,
                },
            )
        except engine.EngineError as error:
            if error.code == "forbidden":
                raise SystemExit(
                    "The engine's test mint is off: set ENGINE_SANDBOX=true for the engine and restart it."
                ) from None
            raise
        await record(
            db,
            entry["id"],
            dict(user_id=user.id, kind="deposit", title="Test money", tag="Deposit", asset=asset, amount=minor),
        )
        return f"Gave {amount} {asset} to {user.handle and '@' + user.handle or user.email}."


def main() -> None:
    parser = argparse.ArgumentParser(prog="tappi-fund", description="Give a user test money (testing only).")
    parser.add_argument("who", help="@username or email")
    parser.add_argument("asset", choices=ASSETS)
    parser.add_argument("amount", help="whole units, e.g. 50000 or 25.5")
    args = parser.parse_args()

    async def run() -> None:
        try:
            print(await fund(args.who, args.asset, args.amount))
        except (HttpError, ValueError) as error:
            sys.exit(getattr(error, "message", str(error)))
        finally:
            await engine.close()
            await dispose()

    asyncio.run(run())
