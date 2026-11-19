"""Bank features when Paga isn't configured (the test engine has no keys), the webhook pass-through,
and engine events becoming activity. The Paga flows themselves are tested in the engine."""

import json
import uuid

from tappi_api.banking import apply_new_events


async def test_bank_features_say_clearly_when_paga_is_not_set_up(make_person):
    ada = await make_person()
    assert (await ada.get("/api/wallet/bank-account")).json() == {"account": None}
    created = await ada.post("/api/wallet/bank-account")
    assert (created.status_code, created.json()) == (
        503,
        {"error": "This isn't available yet. Please try again later."},
    )
    assert (await ada.get("/api/banks")).status_code == 503
    body = {"bankUuid": "B1", "accountNumber": "0123456789", "amount": 500, "pin": "1234"}
    assert (await ada.post("/api/withdraw", body)).status_code == 503


async def test_withdrawal_input_is_checked_first(make_person):
    ada = await make_person()
    bad_number = await ada.post(
        "/api/withdraw", {"bankUuid": "B1", "accountNumber": "123", "amount": 500, "pin": "1234"}
    )
    assert bad_number.status_code == 400
    wrong_pin = await ada.post(
        "/api/withdraw", {"bankUuid": "B1", "accountNumber": "0123456789", "amount": 500, "pin": "0000"}
    )
    assert wrong_pin.json() == {"error": "Wrong PIN. 4 tries left."}
    assert (await ada.get("/api/withdrawals/not-a-uuid")).status_code == 404


async def test_webhooks_pass_through_to_the_engine(client):
    # No signature, and Paga isn't configured on the test engine: the engine refuses, the API relays it.
    response = await client.post("/api/webhooks/paga/funding", content=json.dumps({"amount": 5000}))
    assert response.status_code == 503
    assert (await client.post("/api/webhooks/stripe/x", content="{}")).status_code == 400
    assert (await client.post("/api/webhooks/paga/../../v1", content="{}")).status_code == 404


async def test_engine_events_become_activity_once(make_person, sql):
    ada = await make_person()
    user_id = (await ada.get("/api/me")).json()["user"]["id"]
    # A deposit as the engine would report it after Paga's webhook.
    payload = {
        "asset": "NGN",
        "amount": 250_000,
        "entryId": str(uuid.uuid4()),
        "from": "Chidi Okafor",
        "provider": "paga",
    }
    await sql(
        "INSERT INTO engine.events (owner_id, kind, payload, dedupe_key) VALUES ($1, 'deposit', $2::jsonb, $3)",
        user_id,
        json.dumps(payload),
        f"test-deposit:{user_id}",
    )
    await apply_new_events()
    await apply_new_events()
    feed = (await ada.get("/api/activity")).json()["entries"]
    from_chidi = [e for e in feed if e["title"] == "Chidi Okafor"]
    assert len(from_chidi) == 1
    assert (from_chidi[0]["kind"], from_chidi[0]["amount"], from_chidi[0]["channel"]) == ("deposit", 2500.0, "bank")


async def test_crypto_networks_and_checks(make_person):
    ada = await make_person()
    networks = (await ada.get("/api/crypto/networks")).json()["networks"]
    assert [n["chain"] for n in networks["BTC"]] == ["bitcoin"]
    assert "tron" not in [n["chain"] for n in networks["USDC"]]

    wrong_network = await ada.post("/api/crypto/address", {"asset": "USDC", "chain": "tron"})
    assert wrong_network.json() == {"error": "USDC isn't available on tron."}
    # Bitnob isn't configured on the test engine.
    not_set_up = await ada.post("/api/crypto/address", {"asset": "USDT", "chain": "ethereum"})
    assert (not_set_up.status_code, not_set_up.json()) == (
        503,
        {"error": "This isn't available yet. Please try again later."},
    )

    body = {"asset": "USDT", "chain": "ethereum", "address": "0x" + "a" * 40, "amount": "5", "pin": "0000"}
    assert (await ada.post("/api/crypto/send", body)).json() == {"error": "Wrong PIN. 4 tries left."}
    too_precise = await ada.post("/api/crypto/send", {**body, "amount": "0.0000001", "pin": "1234"})
    assert too_precise.json() == {"error": "USDT amounts have at most 6 decimal places"}
    assert (await ada.get("/api/crypto/sends/nope")).status_code == 404


async def test_swap_checks(make_person):
    ada = await make_person()
    same = await ada.post("/api/swap/quote", {"from": "NGN", "to": "NGN", "amount": 1000})
    assert same.json() == {"error": "Pick two different currencies."}
    bad = await ada.post("/api/swap/quote", {"from": "NGN", "to": "ETH", "amount": 1000})
    assert bad.status_code == 400
    # Bitnob isn't configured on the test engine.
    not_set_up = await ada.post("/api/swap/quote", {"from": "NGN", "to": "USDT", "amount": 1000})
    assert not_set_up.status_code == 503
    wrong_pin = await ada.post("/api/swap", {"quoteId": "q-1", "pin": "0000"})
    assert wrong_pin.json() == {"error": "Wrong PIN. 4 tries left."}
    assert (await ada.get("/api/swaps/nope")).status_code == 404


async def test_usd_card_checks(make_person):
    ada = await make_person()
    # Bitnob isn't configured on the test engine.
    assert (await ada.get("/api/usd-card")).status_code == 503
    form = {
        "firstName": "Ada", "lastName": "Obi", "dateOfBirth": "1990-04-12", "phoneNumber": "08012345678",
        "idType": "passport", "idNumber": "22222222222", "line1": "12 Admiralty Way", "city": "Lagos",
        "state": "Lagos", "postalCode": "106104", "occupation": "13-2011", "employmentStatus": "employed",
        "accountPurpose": "online subscriptions", "annualSalary": "24000", "expectedMonthlyVolume": "500",
    }  # fmt: skip
    assert (await ada.post("/api/usd-card/kyc", form)).status_code == 400, "BVN or NIN only"
    assert (await ada.post("/api/usd-card/kyc", {**form, "idType": "bvn", "idNumber": "123"})).status_code == 400
    wrong_pin = await ada.post("/api/usd-card", {"amount": 10, "payWith": "USDC", "pin": "0000"})
    assert wrong_pin.json() == {"error": "Wrong PIN. 4 tries left."}
    assert (await ada.post("/api/usd-card/details", {"pin": "0000"})).status_code == 400


async def test_tappi_fund_gives_test_money(make_person):
    from tappi_api.testmoney import fund

    ada = await make_person(funded=False)
    message = await fund(f"@{ada.handle}", "NGN", "12500.50")
    assert message == f"Gave 12500.50 NGN to @{ada.handle}."
    assert (await ada.balances())["NGN"] == 12500.5
    feed = (await ada.get("/api/activity")).json()["entries"]
    assert (feed[0]["title"], feed[0]["amount"]) == ("Test money", 12500.5)
