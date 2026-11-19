"""The app speaks in whole units (₦500.25, 12.5 USDT); the engine in smallest units (kobo, sats).
Conversion happens only here, with Decimal, never float."""

from decimal import Decimal, InvalidOperation
from typing import Literal

Asset = Literal["NGN", "USDT", "USDC", "BTC"]
ASSETS: tuple[Asset, ...] = ("NGN", "USDT", "USDC", "BTC")
DECIMALS: dict[str, int] = {"NGN": 2, "USDT": 6, "USDC": 6, "BTC": 8}
# Largest single amount the app accepts, in whole units.
MAX_AMOUNT: dict[str, Decimal] = {
    "NGN": Decimal(1_000_000_000),
    "USDT": Decimal(1_000_000),
    "USDC": Decimal(1_000_000),
    "BTC": Decimal(100),
}


def to_minor(asset: str, amount: Decimal | float | str) -> int:
    """Whole units → smallest units. Refuses more decimal places than the asset has."""
    try:
        value = Decimal(str(amount))
    except InvalidOperation:
        raise ValueError("Enter an amount") from None
    if not value.is_finite() or value <= 0:
        raise ValueError("Enter an amount")
    if value > MAX_AMOUNT[asset]:
        raise ValueError("That amount is too large")
    minor = value.scaleb(DECIMALS[asset])
    if minor != minor.to_integral_value():
        raise ValueError(f"{asset} amounts have at most {DECIMALS[asset]} decimal places")
    return int(minor)


def to_major(asset: str, minor: int) -> float:
    """Smallest units → whole units, as a JSON number for the app."""
    return float(Decimal(minor).scaleb(-DECIMALS[asset]))
