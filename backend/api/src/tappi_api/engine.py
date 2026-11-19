"""Client for the Rust money engine (backend/engine). Every balance change goes through here.

Every engine write is idempotent, so a request that fails on the network is simply sent again.
If the engine stays unreachable, a money movement's outcome is unknown; `transfer` and friends
then ask the engine by idempotency key before reporting failure."""

import asyncio
from typing import Any
from uuid import UUID

import httpx

from .errors import HttpError
from .settings import settings

RETRIES = 3


class InsufficientFunds(HttpError):
    def __init__(self) -> None:
        super().__init__(400, "Not enough balance for this payment.")


class EngineUnavailable(HttpError):
    def __init__(self) -> None:
        super().__init__(503, "Payments are unavailable right now. Please try again.")


# Engine error codes → what the user sees. Anything else is a 500.
FRIENDLY = {
    "invalid_amount": (400, "Enter an amount."),
    "unknown_asset": (400, "That currency isn't supported."),
    "same_account": (400, "You can't send money to yourself."),
    "idempotency_conflict": (409, "This request was already used for a different payment."),
    "hold_closed": (409, "This payment was already settled."),
    "has_active_holds": (409, "Some of this account's money is still on hold. Try again shortly."),
    "not_found": (404, "Not found."),
    "provider_not_configured": (503, "This isn't available yet. Please try again later."),
    "provider_error": (502, "Our payment partner had a problem. Please try again."),
}


class EngineError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"engine {status} {code}: {message}")
        self.code = code


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        s = settings()
        _client = httpx.AsyncClient(
            base_url=s.engine_url,
            headers={"authorization": f"Bearer {s.engine_token}"},
            timeout=httpx.Timeout(10.0),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


async def _call(method: str, path: str, json: Any = None) -> Any:
    for attempt in range(RETRIES):
        try:
            response = await client().request(method, path, json=json)
            break
        except httpx.TransportError:
            if attempt == RETRIES - 1:
                raise EngineUnavailable() from None
            await asyncio.sleep(0.2 * 2**attempt)
    if response.is_success:
        return response.json()
    try:
        error = response.json()["error"]
        code, message = error["code"], error["message"]
    except (ValueError, KeyError, TypeError):
        code, message = "unknown", response.text
    if code == "insufficient_funds":
        raise InsufficientFunds()
    if code == "invalid_request":
        # The engine's own message, written for users ("Load between $2 and $2,500.").
        raise HttpError(400, message)
    if code == "provider_refused":
        # The provider said why it refused (e.g. "Paga: Account not sufficiently verified").
        raise HttpError(503, f"This isn't available right now ({message}).")
    if code in FRIENDLY:
        status, text = FRIENDLY[code]
        raise HttpError(status, text)
    if response.status_code >= 500:
        raise EngineUnavailable()
    raise EngineError(response.status_code, code, message)


async def _move(key: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await _call("POST", path, body)
    except EngineUnavailable:
        # Did it go through before the connection dropped? If the engine can't say, it's still unknown.
        found = await entry_by_key(key)
        if found is None:
            raise
        return found


def user(user_id: UUID | str) -> dict[str, str]:
    return {"owner_type": "user", "owner_id": str(user_id)}


async def balances(user_id: UUID) -> dict[str, int]:
    """Available balance per asset, in smallest units."""
    rows = await _call("GET", f"/v1/owners/user/{user_id}/balances")
    return {row["asset"]: row["available"] for row in rows}


async def entry_by_key(key: str) -> dict[str, Any] | None:
    try:
        return await _call("GET", f"/v1/entries/by-key/{key}")
    except HttpError as error:
        if error.status == 404:
            return None
        raise


async def transfer(
    *,
    key: str,
    kind: str,
    from_user: UUID,
    to_user: UUID,
    asset: str,
    amount: int,
    reference: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return await _move(
        key,
        "/v1/transfers",
        {
            "idempotency_key": key,
            "kind": kind,
            "from": user(from_user),
            "to": user(to_user),
            "asset": asset,
            "amount": amount,
            "reference": reference,
            "metadata": metadata,
        },
    )


async def close_account(user_id: UUID) -> dict[str, Any] | None:
    """Sweeps whatever the user has left to Tappi's closed-accounts books. None if nothing was left."""
    return (await _call("POST", f"/v1/owners/user/{user_id}/close"))["entry"]


# ---------------- Providers ----------------


async def provider_accounts(user_id: UUID) -> list[dict[str, Any]]:
    return await _call("GET", f"/v1/owners/user/{user_id}/provider-accounts")


async def paga_account(user_id: UUID, name: str, email: str | None, phone: str | None) -> dict[str, Any]:
    """The user's own NGN account number at Paga (created the first time)."""
    return await _call(
        "POST", "/v1/paga/accounts", {"owner_id": str(user_id), "name": name, "email": email, "phone": phone}
    )


async def paga_banks() -> list[dict[str, Any]]:
    return await _call("GET", "/v1/paga/banks")


async def paga_resolve(bank_uuid: str, account_number: str, amount: int) -> dict[str, Any]:
    body = {"bank_uuid": bank_uuid, "account_number": account_number, "amount": amount}
    return await _call("POST", "/v1/paga/resolve", body)


async def paga_payout(
    *, key: str, user_id: UUID, amount: int, bank_uuid: str, account_number: str, account_name: str | None
) -> dict[str, Any]:
    """A bank withdrawal. Safe to repeat with the same key; may come back `pending`."""
    body = {
        "idempotency_key": key,
        "owner_id": str(user_id),
        "amount": amount,
        "bank_uuid": bank_uuid,
        "account_number": account_number,
        "account_name": account_name,
    }
    return await _call("POST", "/v1/paga/payouts", body)


async def bitnob_address(
    user_id: UUID, email: str, first_name: str | None, last_name: str | None, asset: str, chain: str
) -> dict[str, Any]:
    """The user's deposit address for an asset on a chain (created at Bitnob the first time)."""
    body = {
        "owner_id": str(user_id),
        "email": email,
        "first_name": first_name,
        "last_name": last_name,
        "asset": asset,
        "chain": chain,
    }
    return await _call("POST", "/v1/bitnob/addresses", body)


async def bitnob_send(
    *, key: str, user_id: UUID, asset: str, chain: str, amount: int, to_address: str
) -> dict[str, Any]:
    """Crypto to an outside address. Safe to repeat with the same key; usually comes back `pending`."""
    body = {
        "idempotency_key": key,
        "owner_id": str(user_id),
        "asset": asset,
        "chain": chain,
        "amount": amount,
        "to_address": to_address,
    }
    return await _call("POST", "/v1/bitnob/sends", body)


async def swap_quote(user_id: UUID, from_asset: str, to_asset: str, amount: int) -> dict[str, Any]:
    """Bitnob prices the swap; the engine keeps the quote. Amounts in smallest units."""
    body = {"owner_id": str(user_id), "from": from_asset, "to": to_asset, "amount": amount}
    return await _call("POST", "/v1/swaps/quote", body)


async def swap(user_id: UUID, quote_id: str) -> dict[str, Any]:
    """Executes a stored quote (at most once per quote)."""
    return await _call("POST", "/v1/swaps", {"owner_id": str(user_id), "quote_id": quote_id})


# ---- USD virtual card (Bitnob) ----


async def card_call(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    return await _call(method, f"/v1/usd-cards{path}", body)


async def op(op_id: UUID) -> dict[str, Any]:
    return await _call("GET", f"/v1/ops/{op_id}")


async def events_after(after: int, limit: int = 200) -> list[dict[str, Any]]:
    return await _call("GET", f"/v1/events?after={after}&limit={limit}")


async def forward_webhook(path: str, body: bytes, headers: dict[str, str]) -> httpx.Response:
    """Passes a provider's webhook to the engine untouched (it checks the signature)."""
    try:
        return await client().post(f"/webhooks/{path}", content=body, headers=headers)
    except httpx.TransportError:
        raise EngineUnavailable() from None
