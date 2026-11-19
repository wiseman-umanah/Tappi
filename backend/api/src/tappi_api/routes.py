"""HTTP routes. Same paths and response shapes as the old Expo API routes, so the app switches by
changing its API URL. Keep these thin; the logic lives in the modules they call."""

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Header, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text

from . import account, banking, cards, crypto, engine, merchant, nearby, swaps, taps, usd_card, wallet
from .ai import assistant, speech
from .ai.languages import LANGUAGE_CODES, list_languages
from .auth import (
    Credentials,
    CurrentUser,
    Db,
    RestoringUser,
    authorization_header,
    request_code,
    set_pin,
    sign_out,
    verify_code,
    verify_pin,
)
from .errors import HttpError
from .handles import check_handle
from .money import Asset, to_minor
from .settings import settings

router = APIRouter(prefix="/api")

Pin = Annotated[str, Field(pattern=r"^\d{4}$")]
# Clients send a fresh one per money action and reuse it on retry, so nothing moves twice.
IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=100)]


def _lower_email(value: str) -> str:
    return value.strip().lower()


class CodeIn(BaseModel):
    email: EmailStr
    _normalize = field_validator("email", mode="before")(_lower_email)


class VerifyIn(CodeIn):
    code: Annotated[str, Field(pattern=r"^\d{6}$")]


class ProfileIn(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=60)] | None = None
    handle: str | None = None
    gender: Literal["female", "male"] | None = None
    language: Literal[LANGUAGE_CODES] | None = None  # type: ignore[valid-type]

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value

    @field_validator("handle")
    @classmethod
    def _handle(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower().removeprefix("@")
        if not re.fullmatch(r"[a-z0-9_]{3,20}", value):
            raise ValueError("Username: 3–20 letters, numbers or _")
        return value


class PinIn(BaseModel):
    pin: Pin
    currentPin: Pin | None = None


class PinCheckIn(BaseModel):
    pin: Pin


class SendIn(BaseModel):
    to: Annotated[str, Field(min_length=1)]
    asset: Asset
    amount: float | str
    pin: Pin


class PinOnlyIn(BaseModel):
    pin: Pin


class ReceivingIn(PinOnlyIn):
    enabled: bool


class ChargeIn(BaseModel):
    amount: float | str
    asset: Literal[merchant.CHARGE_ASSETS] = "NGN"  # type: ignore[valid-type]
    tag: Annotated[str, Field(min_length=1, max_length=30)]


class PayIn(PinOnlyIn):
    # Defaults to the charge's own currency.
    asset: Asset | None = None
    channel: Literal["nfc", "qr", "code", "nearby"] = "qr"


class CardIn(BaseModel):
    brand: Literal[merchant.CARD_BRANDS]  # type: ignore[valid-type]


class TokenIn(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=200)]


class BeaconIn(BaseModel):
    requestId: UUID | None = None


class ResolveIn(BaseModel):
    ids: Annotated[list[Annotated[str, Field(max_length=32)]], Field(max_length=50)]


class CardPatchIn(BaseModel):
    frozen: bool | None = None
    dailyLimit: Literal[cards.DAILY_LIMITS] | None = None  # type: ignore[valid-type]
    fundingAsset: Literal[merchant.CHARGE_ASSETS] | None = None  # type: ignore[valid-type]


class ArmIn(BaseModel):
    pin: Pin | None = None


class ChatIn(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=2000)]
    conversationId: UUID | None = None
    speak: bool = True


class VoiceIn(BaseModel):
    # The recording, base64.
    audio: Annotated[str, Field(min_length=100, max_length=assistant.MAX_BASE64)]
    format: Literal["m4a", "webm", "wav", "mp3"] = "m4a"
    conversationId: UUID | None = None
    speak: bool = True


class ResolveAccountIn(BaseModel):
    bankUuid: Annotated[str, Field(min_length=1, max_length=64)]
    accountNumber: Annotated[str, Field(pattern=r"^\d{10}$")]
    amount: float | str = 100


class WithdrawIn(ResolveAccountIn):
    accountName: Annotated[str, Field(max_length=100)] | None = None
    pin: Pin


CryptoAsset = Literal["USDT", "USDC", "BTC"]


class SwapQuoteIn(BaseModel):
    # `from` is a Python keyword: the JSON field is still "from".
    from_: Asset = Field(alias="from")
    to: Asset
    amount: float | str


Text = Annotated[str, Field(min_length=1, max_length=100)]


class CardKycIn(BaseModel):
    """Bitnob card KYC. BVN or NIN (verified instantly, no photo)."""

    firstName: Text
    lastName: Text
    dateOfBirth: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    phoneNumber: Annotated[str, Field(pattern=r"^\+?\d{10,14}$")]
    idType: Literal["bvn", "nin"]
    idNumber: Annotated[str, Field(pattern=r"^\d{11}$")]
    line1: Text
    city: Text
    state: Text
    postalCode: Annotated[str, Field(min_length=3, max_length=12)]
    occupation: Text
    employmentStatus: Literal["employed", "self_employed", "unemployed", "retired", "student"]
    accountPurpose: Text
    annualSalary: Annotated[str, Field(pattern=r"^\d{1,12}$")]
    expectedMonthlyVolume: Annotated[str, Field(pattern=r"^\d{1,12}$")]


class CardMoneyIn(BaseModel):
    amount: float | str
    payWith: Literal["USDT", "USDC"] = "USDC"
    pin: Pin


class CardFreezeIn(BaseModel):
    frozen: bool


class SwapIn(BaseModel):
    quoteId: Annotated[str, Field(min_length=1, max_length=100)]
    pin: Pin


class CryptoAddressIn(BaseModel):
    asset: CryptoAsset
    chain: Annotated[str, Field(min_length=2, max_length=20)]


class CryptoSendIn(CryptoAddressIn):
    address: Annotated[str, Field(min_length=10, max_length=120)]
    amount: float | str
    pin: Pin


def _minor(asset: str, amount: float | str) -> int:
    try:
        return to_minor(asset, amount)
    except ValueError as error:
        raise HttpError(400, str(error)) from None


@router.get("/health")
async def health(db: Db) -> dict:
    await db.execute(text("SELECT 1"))
    try:
        response = await engine.client().get("/health")
    except httpx.HTTPError:
        raise HttpError(503, "The money engine is unavailable.") from None
    if not response.is_success:
        raise HttpError(503, "The money engine is unavailable.")
    return {"ok": True}


# ---------------- Auth ----------------


@router.post("/auth/code")
async def auth_code(body: CodeIn, db: Db) -> dict:
    """While TAPPI_AUTO_CODE is on, the code comes back (`devCode`) so the app can fill it in."""
    return await request_code(db, body.email)


@router.post("/auth/verify")
async def auth_verify(body: VerifyIn, db: Db) -> dict:
    token, user = await verify_code(db, body.email, body.code)
    return {"token": token, **await wallet.me(user)}


@router.post("/auth/logout")
async def auth_logout(db: Db, credentials: Credentials) -> dict:
    await sign_out(db, authorization_header(credentials))
    return {"ok": True}


# ---------------- Profile ----------------


@router.get("/me")
async def get_me(user: RestoringUser) -> dict:
    return await wallet.me(user)


@router.patch("/me")
async def patch_me(body: ProfileIn, user: CurrentUser, db: Db) -> dict:
    return await wallet.me(await wallet.update_profile(db, user, body.model_dump(exclude_none=True)))


@router.post("/me/pin")
async def post_pin(body: PinIn, user: CurrentUser, db: Db) -> dict:
    """Changing an existing PIN needs the current one."""
    if user.pin_hash:
        if not body.currentPin:
            raise HttpError(400, "Enter your current PIN.")
        await verify_pin(db, user, body.currentPin)
        if body.currentPin == body.pin:
            raise HttpError(400, "Choose a different PIN from your current one.")
    await set_pin(db, user, body.pin)
    return {"ok": True}


@router.post("/me/pin/check")
async def check_pin(body: PinCheckIn, user: CurrentUser, db: Db) -> dict:
    """The first step of changing a PIN (counts toward the lockout)."""
    await verify_pin(db, user, body.pin)
    return {"ok": True}


@router.post("/me/receiving")
async def post_receiving(body: ReceivingIn, user: CurrentUser, db: Db) -> dict:
    """Disable or re-enable the account for incoming money."""
    await verify_pin(db, user, body.pin)
    return await wallet.me(await account.set_receiving(db, user, body.enabled))


@router.post("/me/delete")
async def post_delete(body: PinOnlyIn, user: CurrentUser, db: Db) -> dict:
    """Signs out everywhere; restorable by signing in during the restore window."""
    await verify_pin(db, user, body.pin)
    return await account.delete_account(db, user)


@router.post("/me/restore")
async def post_restore(user: RestoringUser, db: Db) -> dict:
    return await wallet.me(await account.restore_account(db, user))


@router.get("/handles/{handle}")
async def get_handle(handle: str, user: CurrentUser, db: Db, name: str | None = None) -> dict:
    return await check_handle(db, user, handle, name)


@router.get("/users/{handle}")
async def get_user(handle: str, _: CurrentUser, db: Db) -> dict:
    return await wallet.lookup_handle(db, handle)


# ---------------- Money ----------------


@router.post("/send")
async def send(body: SendIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None) -> dict:
    amount = _minor(body.asset, body.amount)
    await verify_pin(db, user, body.pin)
    return await wallet.send(db, user, body.to, body.asset, amount, idempotency_key or uuid4().hex)


@router.get("/rate")
async def rate() -> dict:
    """Naira per US dollar, for showing rough equivalents. Indicative only: no money moves at this
    rate (swaps, when they come, are quoted live by Bitnob)."""
    return {"ngnPerUsd": settings().ngn_per_usd, "indicative": True}


@router.get("/activity")
async def activity(user: CurrentUser, db: Db) -> dict:
    return await wallet.activity(db, user)


# ---------------- Charges (merchant Terminal ↔ customer) ----------------


@router.post("/requests")
async def create_charge(body: ChargeIn, user: CurrentUser, db: Db) -> dict:
    """The Terminal's Charge button."""
    return await merchant.create_request(db, user, _minor(body.asset, body.amount), body.tag, body.asset)


@router.get("/requests/{id_or_code}")
async def get_charge(id_or_code: str, user: CurrentUser, db: Db) -> dict:
    """Both phones poll this for the charge's state."""
    return await merchant.get_request(db, user, id_or_code)


@router.post("/requests/{id_or_code}/pay")
async def pay_charge(id_or_code: str, body: PayIn, user: CurrentUser, db: Db) -> dict:
    await verify_pin(db, user, body.pin)
    return await merchant.pay_request(db, user, id_or_code, body.asset, body.channel)


@router.post("/requests/{request_id}/cancel")
async def cancel_charge(request_id: str, user: CurrentUser, db: Db) -> dict:
    await merchant.cancel_request(db, user, request_id)
    return {"ok": True}


@router.post("/requests/{request_id}/refund")
async def refund_charge(request_id: str, body: PinOnlyIn, user: CurrentUser, db: Db) -> dict:
    await verify_pin(db, user, body.pin)
    return await merchant.refund(db, user, request_id)


@router.post("/requests/{request_id}/tap")
async def tap_charge(request_id: str, body: TokenIn, user: CurrentUser, db: Db) -> dict:
    """The merchant's phone read a customer's phone."""
    return await taps.claim_tap(db, user, request_id, body.token)


@router.post("/requests/{request_id}/tappi-card")
async def tappi_card_charge(request_id: str, body: TokenIn, user: CurrentUser, db: Db) -> dict:
    """The merchant's phone read a customer's Tappi card: paid at once."""
    return await cards.pay_with_card(db, user, request_id, body.token)


@router.post("/requests/{request_id}/card")
async def card_charge(request_id: str, body: CardIn, user: CurrentUser, db: Db) -> dict:
    """A bank card tapped the merchant's phone: refused until there's a card acquirer."""
    return await merchant.pay_by_card(db, user, request_id, body.brand)


@router.get("/merchant")
async def merchant_dashboard(user: CurrentUser, db: Db) -> dict:
    """Transactions, analytics and payout balance."""
    return await merchant.dashboard(db, user)


# ---------------- Taps and nearby ----------------


@router.post("/taps")
async def tap_token(user: CurrentUser) -> dict:
    """A short-lived token the payer's phone presents over NFC."""
    return taps.issue_tap_token(user)


@router.get("/taps")
async def pending_taps(user: CurrentUser, db: Db, since: str | None = None) -> dict:
    """What a payee's phone just read this payer's phone into, if anything."""
    try:
        after = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else datetime.fromtimestamp(0, UTC)
    except ValueError:
        after = datetime.fromtimestamp(0, UTC)
    if after.tzinfo is None:
        after = after.replace(tzinfo=UTC)
    return await taps.pending_tap(db, user, after)


@router.post("/taps/person")
async def person_tap(body: TokenIn, user: CurrentUser, db: Db) -> dict:
    """This phone (on Receive) read a payer's phone."""
    return await taps.claim_person_tap(db, user, body.token)


@router.post("/nearby/beacon")
async def start_beacon(body: BeaconIn, user: CurrentUser, db: Db) -> dict:
    """A Bluetooth beacon id for this phone to announce."""
    return await nearby.issue_beacon(db, user, body.requestId)


@router.delete("/nearby/beacon")
async def stop_beacon(user: CurrentUser, db: Db) -> dict:
    return await nearby.end_beacon(db, user)


@router.post("/nearby/resolve")
async def resolve_beacons(body: ResolveIn, user: CurrentUser, db: Db) -> dict:
    """Who is behind the beacon ids this phone heard."""
    return await nearby.resolve_beacons(db, user, body.ids)


# ---------------- Tappi card ----------------


@router.get("/card")
async def get_card(user: CurrentUser, db: Db) -> dict:
    return await cards.get_card(db, user)


@router.patch("/card")
async def patch_card(body: CardPatchIn, user: CurrentUser, db: Db) -> dict:
    return await cards.update_card(db, user, body.model_dump(exclude_none=True))


@router.post("/card/details")
async def card_details(body: PinOnlyIn, user: CurrentUser, db: Db) -> dict:
    """Full number, expiry and CVV."""
    return await cards.card_details(db, user, body.pin)


@router.post("/card/arm")
async def arm_card(body: ArmIn, user: CurrentUser, db: Db) -> dict:
    """'Tap to pay': the card can be read for a minute."""
    return await cards.arm_card(db, user, body.pin)


@router.delete("/card/arm")
async def disarm_card(user: CurrentUser, db: Db) -> dict:
    return await cards.disarm_card(db, user)


# ---------------- Tappi AI ----------------


@router.get("/ai/languages")
async def ai_languages() -> dict:
    """What Tappi AI can speak (Profile → Tappi AI language)."""
    return list_languages()


@router.post("/ai/chat")
async def ai_chat(body: ChatIn, user: CurrentUser, db: Db) -> dict:
    """A typed message; no conversationId starts a new chat."""
    return await assistant.converse(db, user, body.text, conversation_id=body.conversationId, speak=body.speak)


@router.post("/ai/voice")
async def ai_voice(body: VoiceIn, user: CurrentUser, db: Db) -> dict:
    """A spoken message (base64 JSON, not multipart: React Native's multipart is flaky on Android)."""
    return await assistant.voice_turn(db, user, body.audio, body.format, body.conversationId, body.speak)


@router.get("/ai/conversations")
async def ai_conversations(user: CurrentUser, db: Db) -> dict:
    return await assistant.list_conversations(db, user)


@router.get("/ai/conversations/{conversation_id}")
async def ai_conversation(conversation_id: str, user: CurrentUser, db: Db) -> dict:
    return await assistant.get_conversation(db, user, conversation_id)


@router.delete("/ai/conversations/{conversation_id}")
async def ai_delete_conversation(conversation_id: str, user: CurrentUser, db: Db) -> dict:
    return await assistant.delete_conversation(db, user, conversation_id)


@router.get("/ai/speech/{speech_id}/ready")
async def ai_speech_ready(speech_id: str, user: CurrentUser) -> dict:
    """Waits for a reply's voice; {ready: false} if none could be made."""
    return await speech.speech_ready(user.id, speech_id)


@router.get("/ai/speech/{speech_id}")
async def ai_speech(speech_id: str, user: CurrentUser) -> Response:
    """A reply's voice (WAV). Ask …/ready first."""
    audio = await speech.speech_audio(user.id, speech_id)
    return Response(audio, media_type="audio/wav", headers={"cache-control": "private, max-age=300"})


# ---------------- Bank: account number, withdrawals (Paga, through the engine) ----------------


@router.get("/wallet/bank-account")
async def get_bank_account(user: CurrentUser) -> dict:
    """The user's own account number for naira deposits, if they have one yet."""
    return {"account": await banking.bank_account(user, create=False)}


@router.post("/wallet/bank-account")
async def create_bank_account(user: CurrentUser) -> dict:
    return {"account": await banking.bank_account(user, create=True)}


@router.get("/banks")
async def list_banks(_: CurrentUser) -> dict:
    return await banking.banks()


@router.post("/banks/resolve")
async def resolve_bank_account(body: ResolveAccountIn, _: CurrentUser) -> dict:
    return await banking.resolve(body.bankUuid, body.accountNumber, _minor("NGN", body.amount))


@router.post("/withdraw")
async def withdraw(body: WithdrawIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None) -> dict:
    """Naira to a bank account. Often `pending` at first: poll GET /api/withdrawals/{id}."""
    amount = _minor("NGN", body.amount)
    await verify_pin(db, user, body.pin)
    key = idempotency_key or uuid4().hex
    return await banking.withdraw(user, amount, body.bankUuid, body.accountNumber, body.accountName, key)


@router.get("/withdrawals/{op_id}")
async def get_withdrawal(op_id: str, user: CurrentUser) -> dict:
    return await banking.withdrawal(user, op_id)


# ---------------- Swaps (Bitnob trading, through the engine) ----------------


@router.post("/swap/quote")
async def swap_quote(body: SwapQuoteIn, user: CurrentUser) -> dict:
    """A live rate for swapping `amount` of `from` into `to`. Valid until `expiresAt` (seconds)."""
    return await swaps.quote(user, body.from_, body.to, _minor(body.from_, body.amount))


@router.post("/swap")
async def swap(body: SwapIn, user: CurrentUser, db: Db) -> dict:
    """Executes a quote. Only its id is sent: the amounts are the ones Bitnob quoted."""
    await verify_pin(db, user, body.pin)
    return await swaps.execute(user, body.quoteId)


@router.get("/swaps/{op_id}")
async def swap_status(op_id: str, user: CurrentUser) -> dict:
    return await swaps.status(user, op_id)


# ---------------- USD virtual card (Bitnob) ----------------


@router.get("/usd-card")
async def usd_card_overview(user: CurrentUser) -> dict:
    """KYC state, and the card (status, last 4, balance) if there is one."""
    return await usd_card.overview(user)


@router.get("/usd-card/occupations")
async def usd_card_occupations(_: CurrentUser) -> Any:
    """Occupation codes for the KYC form (Bitnob's list)."""
    return await usd_card.occupations()


@router.post("/usd-card/kyc")
async def usd_card_kyc(body: CardKycIn, user: CurrentUser) -> dict:
    phone = body.phoneNumber.removeprefix("+234").removeprefix("234").lstrip("0")
    form = {
        "first_name": body.firstName, "last_name": body.lastName, "date_of_birth": body.dateOfBirth,
        "phone_number": phone, "id_type": body.idType, "id_number": body.idNumber, "line1": body.line1,
        "city": body.city, "state": body.state, "postal_code": body.postalCode, "occupation": body.occupation,
        "employment_status": body.employmentStatus, "account_purpose": body.accountPurpose,
        "annual_salary": body.annualSalary, "expected_monthly_volume": body.expectedMonthlyVolume,
    }  # fmt: skip
    return await usd_card.submit_kyc(user, form)


@router.post("/usd-card")
async def usd_card_create(body: CardMoneyIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None) -> dict:
    """Creates the card with `amount` dollars on it, paid from USDT or USDC (+ $1 + top-up fee)."""
    amount = _minor(body.payWith, body.amount)
    await verify_pin(db, user, body.pin)
    return await usd_card.create(user, amount, body.payWith, idempotency_key or uuid4().hex)


@router.post("/usd-card/fund")
async def usd_card_fund(body: CardMoneyIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None) -> dict:
    amount = _minor(body.payWith, body.amount)
    await verify_pin(db, user, body.pin)
    return await usd_card.fund(user, amount, body.payWith, idempotency_key or uuid4().hex)


@router.post("/usd-card/withdraw")
async def usd_card_withdraw(
    body: CardMoneyIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None
) -> dict:
    """Card money back to the user's USDT or USDC (whichever paid for the card)."""
    amount = _minor("USDC", body.amount)
    await verify_pin(db, user, body.pin)
    return await usd_card.withdraw(user, amount, idempotency_key or uuid4().hex)


@router.post("/usd-card/freeze")
async def usd_card_freeze(body: CardFreezeIn, user: CurrentUser) -> dict:
    return await usd_card.set_frozen(user, body.frozen)


@router.post("/usd-card/terminate")
async def usd_card_terminate(body: PinOnlyIn, user: CurrentUser, db: Db) -> dict:
    """Closes the card; its balance comes back to the user's USDT or USDC."""
    await verify_pin(db, user, body.pin)
    return await usd_card.terminate(user)


@router.post("/usd-card/details")
async def usd_card_details(body: PinOnlyIn, user: CurrentUser, db: Db) -> dict:
    """Card number, CVV and expiry, after the PIN. Never stored by Tappi."""
    await verify_pin(db, user, body.pin)
    return await usd_card.details(user)


@router.get("/usd-card/transactions")
async def usd_card_transactions(user: CurrentUser) -> dict:
    return await usd_card.transactions(user)


# ---------------- Crypto: deposit addresses and sending out (Bitnob, through the engine) ----------------


@router.get("/crypto/networks")
async def crypto_networks(_: CurrentUser) -> dict:
    """Which networks each coin can be received and sent on."""
    return {"networks": crypto.NETWORKS}


@router.post("/crypto/address")
async def crypto_address(body: CryptoAddressIn, user: CurrentUser) -> dict:
    return await crypto.deposit_address(user, body.asset, body.chain.lower())


@router.post("/crypto/send")
async def crypto_send(body: CryptoSendIn, user: CurrentUser, db: Db, idempotency_key: IdempotencyKey = None) -> dict:
    """Usually `pending` at first: poll GET /api/crypto/sends/{id}."""
    amount = _minor(body.asset, body.amount)
    await verify_pin(db, user, body.pin)
    return await crypto.send(
        user, body.asset, body.chain.lower(), amount, body.address.strip(), idempotency_key or uuid4().hex
    )


@router.get("/crypto/sends/{op_id}")
async def crypto_sent(op_id: str, user: CurrentUser) -> dict:
    return await crypto.sent(user, op_id)


# ---------------- Provider webhooks: passed to the engine, which checks the signature ----------------

WEBHOOK_HEADERS = ("content-type", "x-paga-hash", "x-paga-hash-parameters", "x-paga-hash-v3", "x-paga-hash-v3-parameters",
                   "x-paga-attempt-id", "x-bitnob-signature", "x-bitnob-event-id")  # fmt: skip


@router.post("/webhooks/{provider}/{kind}")
async def provider_webhook(provider: Literal["paga", "bitnob"], kind: str, request: Request) -> Response:
    if not re.fullmatch(r"[a-z_]{1,32}", kind):
        raise HttpError(404, "Not found.")
    headers = {h: v for h in WEBHOOK_HEADERS if (v := request.headers.get(h)) is not None}
    answer = await engine.forward_webhook(f"{provider}/{kind}", await request.body(), headers)
    return Response(answer.content, status_code=answer.status_code, media_type=answer.headers.get("content-type"))
