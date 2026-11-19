from collections.abc import AsyncIterator
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, MetaData, Text, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .settings import settings

Gender = Literal["female", "male"]
# active → normal; disabled → no incoming money; deleting → restorable by signing in until
# delete_after; closed → personal data erased, ledger kept until retain_until.
AccountStatus = Literal["active", "disabled", "deleting", "closed"]
EntryKind = Literal[
    "deposit", "payment_in", "payment_out", "swap", "refund_in", "refund_out", "settlement", "withdrawal", "closure"
]


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Base(DeclarativeBase):
    metadata = MetaData(schema="app")


class User(Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    # Null once the account is closed, so the address can sign up again.
    email: Mapped[str | None] = mapped_column(Text, unique=True)
    # HMAC of the email, kept after closing so records can still be matched for compliance.
    email_hash: Mapped[str | None] = mapped_column(Text)
    handle: Mapped[str | None] = mapped_column(Text, unique=True)
    name: Mapped[str | None] = mapped_column(Text)
    gender: Mapped[str | None] = mapped_column(Text)
    pin_hash: Mapped[str | None] = mapped_column(Text)
    pin_failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    pin_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, default="active", server_default="active")
    # Language Tappi AI speaks and listens in.
    language: Mapped[str] = mapped_column(Text, default="en", server_default="en")
    welcomed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    delete_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retain_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class LoginCode(Base):
    """Only an HMAC of the code is stored."""

    __tablename__ = "login_codes"

    email: Mapped[str] = mapped_column(Text, primary_key=True)
    code_hash: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Session(Base):
    """Bearer sessions. Only an HMAC of the token is stored."""

    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class Entry(Base):
    """The user's activity feed. The engine's ledger is the record of money; this is what the app
    shows. Amounts are in the asset's smallest unit, signed from the user's point of view."""

    __tablename__ = "entries"
    __table_args__ = (
        Index("entries_user_idx", "user_id", "created_at"),
        # One row per user per asset per engine entry, so a retried request can't list a payment twice.
        Index("entries_ledger_idx", "ledger_entry_id", "user_id", "asset", unique=True),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    tag: Mapped[str] = mapped_column(Text)
    asset: Mapped[str] = mapped_column(Text)
    amount: Mapped[int] = mapped_column(BigInteger)
    asset_in: Mapped[str | None] = mapped_column(Text)
    amount_in: Mapped[int | None] = mapped_column(BigInteger)
    channel: Mapped[str | None] = mapped_column(Text)
    ledger_entry_id: Mapped[UUID] = mapped_column()
    request_id: Mapped[UUID | None] = mapped_column(ForeignKey("payment_requests.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _now()


RequestStatus = Literal["pending", "paid", "refunded", "cancelled"]
# nfc = customer's phone tapped the merchant's; card = a bank card tapped it (needs an acquirer: refused for now);
# nearby = picked from the Bluetooth list; tappi_card = the customer's Tappi card on their phone.
Channel = Literal["nfc", "qr", "code", "card", "nearby", "tappi_card"]


class PaymentRequest(Base):
    """A merchant's charge from the Terminal. Paid by a tapped phone or card, QR or short code.
    Amounts are in the asset's smallest unit."""

    __tablename__ = "payment_requests"
    __table_args__ = (Index("payment_requests_merchant_idx", "merchant_id", "created_at"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(Text, unique=True)
    merchant_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    amount: Mapped[int] = mapped_column(BigInteger)
    # What the merchant charges in, and receives exactly.
    asset: Mapped[str] = mapped_column(Text)
    tag: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    payer_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    pay_asset: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str | None] = mapped_column(Text)
    # The customer whose phone touched the merchant's; they still approve with their PIN.
    tapped_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    tapped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Scheme of the card that paid (Visa, Mastercard, Verve…), for card payments.
    card_brand: Mapped[str | None] = mapped_column(Text)
    ledger_entry_id: Mapped[UUID | None] = mapped_column()
    refund_entry_id: Mapped[UUID | None] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class NearbyBeacon(Base):
    """A phone in tap mode (Receive, or a merchant with a charge open) announces a random id over
    Bluetooth; phones around ask the server who it is. Ids are short-lived and replaced often."""

    __tablename__ = "nearby_beacons"
    __table_args__ = (Index("nearby_beacons_user_idx", "user_id"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Set for a merchant's open charge: picking them opens that charge.
    request_id: Mapped[UUID | None] = mapped_column(ForeignKey("payment_requests.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class PersonTap(Base):
    """The payee's phone (on Receive) read the payer's phone, so the payer's Pay screen opens Send."""

    __tablename__ = "person_taps"
    __table_args__ = (Index("person_taps_payer_idx", "payer_id", "created_at"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    payer_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    payee_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _now()


class Card(Base):
    """The Tappi card: the phone is the card. Spends from the user's balance inside Tappi, with
    freeze, a daily limit and which balance pays. Not a bank card (that's the Bitnob USD card, later)."""

    __tablename__ = "cards"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    number: Mapped[str] = mapped_column(Text)
    exp_month: Mapped[int] = mapped_column(Integer)
    exp_year: Mapped[int] = mapped_column(Integer)
    cvv: Mapped[str] = mapped_column(Text)
    frozen: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Kobo.
    daily_limit: Mapped[int] = mapped_column(BigInteger, default=10_000_000, server_default="10000000")
    funding_asset: Mapped[str] = mapped_column(Text, default="NGN", server_default="NGN")
    # Set by "Tap to pay"; cleared when a merchant uses it or it runs out.
    armed_nonce: Mapped[str | None] = mapped_column(Text)
    armed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class AiConversation(Base):
    """A Tappi AI chat. Each one is its own thread the user can come back to."""

    __tablename__ = "ai_conversations"
    __table_args__ = (Index("ai_conversations_user_idx", "user_id", "updated_at"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class AiMessage(Base):
    """A message in a chat. Only the last few turns go back to the model."""

    __tablename__ = "ai_messages"
    __table_args__ = (Index("ai_messages_conversation_idx", "conversation_id", "created_at"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    conversation_id: Mapped[UUID] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    actions: Mapped[list[dict] | None] = mapped_column(JSON)
    spoken: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = _now()


_engine = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _engine, _sessionmaker
    if _sessionmaker is None:
        _engine = create_async_engine(settings().database_url, pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _sessionmaker


async def get_db() -> AsyncIterator[AsyncSession]:
    async with sessionmaker()() as session:
        yield session


async def dispose() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = _sessionmaker = None
