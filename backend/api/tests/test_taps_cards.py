import asyncio
from datetime import UTC, datetime

from test_charges import charge


async def test_tap_token_names_the_payer_and_cannot_be_forged(make_person):
    shop, ada = await make_person(), await make_person()
    token = (await ada.post("/api/taps")).json()
    assert token["link"] == f"tappi://tap/{token['token']}"
    created = await charge(shop, 300)

    forged = token["token"][:-2] + ("aa" if not token["token"].endswith("aa") else "bb")
    bad = await shop.post(f"/api/requests/{created['id']}/tap", {"token": forged})
    assert bad.json() == {"error": "That isn't a Tappi phone."}
    own = await shop.post(
        f"/api/requests/{created['id']}/tap", {"token": (await shop.post("/api/taps")).json()["token"]}
    )
    assert own.status_code == 400


async def test_merchant_taps_customer_who_then_approves(make_person):
    shop, ada = await make_person(), await make_person()
    since = datetime.now(UTC).isoformat()
    assert (await ada.get("/api/taps", params={"since": since})).json() == {"charge": None, "person": None}

    created = await charge(shop, 750)
    token = (await ada.post("/api/taps")).json()["token"]
    tapped = await shop.post(f"/api/requests/{created['id']}/tap", {"token": token})
    assert tapped.json()["customer"].startswith("Test ")
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["tapped"] == tapped.json()["customer"]

    pending = (await ada.get("/api/taps", params={"since": since})).json()
    assert pending == {"charge": {"code": created["code"]}, "person": None}
    paid = await ada.post(f"/api/requests/{created['code']}/pay", {"pin": "1234", "channel": "nfc"})
    assert paid.status_code == 200
    assert (await ada.get("/api/taps", params={"since": since})).json()["charge"] is None


async def test_person_tap_opens_send_on_the_payers_phone(make_person):
    ada, bola = await make_person(), await make_person()
    since = datetime.now(UTC).isoformat()
    token = (await ada.post("/api/taps")).json()["token"]
    assert (await bola.post("/api/taps/person", {"token": token})).status_code == 200
    person = (await ada.get("/api/taps", params={"since": since})).json()["person"]
    assert person["handle"] == bola.handle


async def test_nearby_finds_people_and_open_charges(make_person):
    ada, bola, shop = await make_person(), await make_person(), await make_person()
    bola_beacon = (await bola.post("/api/nearby/beacon", {})).json()["id"]
    created = await charge(shop, 1200)
    shop_beacon = (await shop.post("/api/nearby/beacon", {"requestId": created["id"]})).json()["id"]
    own = (await ada.post("/api/nearby/beacon", {})).json()["id"]

    found = (
        await ada.post("/api/nearby/resolve", {"ids": [bola_beacon, shop_beacon.upper(), own, "nonsense", "0" * 16]})
    ).json()
    by_kind = {n["kind"]: n for n in found["nearby"]}
    assert set(by_kind) == {"person", "merchant"}  # not herself, not unknown ids
    assert by_kind["person"]["handle"] == bola.handle
    assert by_kind["merchant"]["charge"] == {"code": created["code"], "amount": 1200.0, "asset": "NGN", "tag": "Food"}

    # Renewing replaces the old id; leaving makes the phone unfindable.
    renewed = (await bola.post("/api/nearby/beacon", {})).json()["id"]
    assert renewed != bola_beacon
    await bola.client.delete("/api/nearby/beacon", headers=bola.headers)
    assert (await ada.post("/api/nearby/resolve", {"ids": [bola_beacon, renewed]})).json() == {"nearby": []}

    # A disabled account isn't findable, and can't announce itself.
    await shop.post("/api/me/receiving", {"enabled": False, "pin": "1234"})
    assert (await ada.post("/api/nearby/resolve", {"ids": [shop_beacon]})).json() == {"nearby": []}
    assert (await shop.post("/api/nearby/beacon", {})).status_code == 403


async def test_tappi_card_settings_and_details(make_person):
    ada = await make_person()
    card = (await ada.get("/api/card")).json()
    assert card["frozen"] is False and card["dailyLimit"] == 100000 and card["fundingAsset"] == "NGN"
    assert card["limits"] == [20000, 50000, 100000, 200000, 500000]

    wrong_pin = await ada.post("/api/card/details", {"pin": "0000"})
    assert wrong_pin.status_code == 400
    details = (await ada.post("/api/card/details", {"pin": "1234"})).json()
    digits = details["number"].replace(" ", "")
    assert digits.startswith("889912") and digits.endswith(card["last4"]) and len(digits) == 16
    total = sum(int(d) if i % 2 else (int(d) * 2 - 9 if int(d) * 2 > 9 else int(d) * 2) for i, d in enumerate(digits))
    assert total % 10 == 0, "Luhn-valid"

    changed = (
        await ada.client.patch("/api/card", json={"dailyLimit": 20000, "fundingAsset": "USDC"}, headers=ada.headers)
    ).json()
    assert (changed["dailyLimit"], changed["fundingAsset"]) == (20000, "USDC")
    assert (await ada.client.patch("/api/card", json={"dailyLimit": 12345}, headers=ada.headers)).status_code == 400


async def test_tappi_card_tap_pays_once(make_person):
    shop, ada = await make_person(), await make_person()
    created = await charge(shop, 2000)
    armed = (await ada.post("/api/card/arm", {})).json()
    token = armed["link"].removeprefix("tappi://card/")

    results = await asyncio.gather(
        shop.post(f"/api/requests/{created['id']}/tappi-card", {"token": token}),
        shop.post(f"/api/requests/{created['id']}/tappi-card", {"token": token}),
    )
    assert sorted(r.status_code for r in results) == [200, 410]
    assert (await ada.balances())["NGN"] == 48000
    card = (await ada.get("/api/card")).json()
    assert card["spentToday"] == 2000 and card["armedUntil"] is None
    assert card["lastPayment"]["amount"] == 2000


async def test_tappi_card_rules(make_person):
    shop, ada = await make_person(), await make_person()

    # Frozen cards can't be armed, and freezing disarms.
    armed = (await ada.post("/api/card/arm", {})).json()
    await ada.client.patch("/api/card", json={"frozen": True}, headers=ada.headers)
    assert (await ada.post("/api/card/arm", {})).json() == {"error": "Your card is frozen. Unfreeze it to pay."}
    first = await charge(shop, 100)
    stale = await shop.post(
        f"/api/requests/{first['id']}/tappi-card", {"token": armed["link"].removeprefix("tappi://card/")}
    )
    assert stale.status_code == 410
    await ada.client.patch("/api/card", json={"frozen": False}, headers=ada.headers)

    # Currency mismatch is caught before the tap is used up.
    dollars = await charge(shop, 1, asset="USDC")
    token = (await ada.post("/api/card/arm", {})).json()["link"].removeprefix("tappi://card/")
    mismatch = await shop.post(f"/api/requests/{dollars['id']}/tappi-card", {"token": token})
    assert mismatch.status_code == 409 and "pays from NGN" in mismatch.json()["error"]
    assert (await shop.post(f"/api/requests/{first['id']}/tappi-card", {"token": token})).status_code == 200

    # Daily limit (₦20,000): a ₦20,500 charge is refused.
    await ada.client.patch("/api/card", json={"dailyLimit": 20000}, headers=ada.headers)
    big = await charge(shop, 20_500)
    token = (await ada.post("/api/card/arm", {})).json()["link"].removeprefix("tappi://card/")
    over = await shop.post(f"/api/requests/{big['id']}/tappi-card", {"token": token})
    assert over.status_code == 402
    assert (await shop.get(f"/api/requests/{big['id']}")).json()["state"] == "pending"

    # Own card.
    mine = (await shop.post("/api/card/arm", {})).json()["link"].removeprefix("tappi://card/")
    assert (await shop.post(f"/api/requests/{big['id']}/tappi-card", {"token": mine})).json() == {
        "error": "That's your own card."
    }
