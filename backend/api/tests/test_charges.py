import asyncio


async def charge(merchant, amount=2500, asset="NGN", tag="Food") -> dict:
    response = await merchant.post("/api/requests", {"amount": amount, "asset": asset, "tag": tag})
    assert response.status_code == 200, response.text
    return response.json()


async def test_charge_paid_by_code(make_person):
    shop, ada = await make_person(), await make_person()
    created = await charge(shop, 2500.75)
    assert created["state"] == "pending"
    assert created["link"] == f"tappi://pay/{created['code']}"
    assert len(created["code"]) == 6

    seen = (await ada.get(f"/api/requests/{created['code'].lower()}")).json()
    assert seen["id"] == created["id"] and seen["amount"] == 2500.75

    paid = await ada.post(f"/api/requests/{created['code']}/pay", {"pin": "1234", "channel": "code"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["amount"] == 2500.75
    assert (await ada.balances())["NGN"] == 47499.25
    assert (await shop.balances())["NGN"] == 52500.75

    after = (await shop.get(f"/api/requests/{created['id']}")).json()
    assert after["state"] == "paid" and after["channel"] == "code" and after["reference"] == paid.json()["reference"]
    feed = (await ada.get("/api/activity")).json()["entries"][0]
    assert (feed["kind"], feed["tag"], feed["amount"]) == ("payment_out", "Food", -2500.75)


async def test_a_charge_is_paid_once_even_by_two_phones_at_once(make_person):
    shop, ada, bola = await make_person(), await make_person(), await make_person()
    created = await charge(shop, 1000)
    results = await asyncio.gather(
        ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"}),
        bola.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"}),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    assert (await shop.balances())["NGN"] == 51000
    assert (await ada.balances())["NGN"] + (await bola.balances())["NGN"] == 99000


async def test_failed_payment_reopens_the_charge(make_person):
    shop, ada = await make_person(), await make_person()
    created = await charge(shop, 60_000)
    broke = await ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"})
    assert broke.json() == {"error": "Not enough balance for this payment."}
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["state"] == "pending"
    await ada.fund("NGN", "50000")
    assert (await ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"})).status_code == 200


async def test_charge_rules(make_person, sql):
    shop, ada = await make_person(), await make_person()
    own = await charge(shop)
    assert (await shop.post(f"/api/requests/{own['id']}/pay", {"pin": "1234"})).json() == {
        "error": "You can't pay your own charge."
    }

    usdc = await charge(shop, 3, asset="USDC")
    wrong_currency = await ada.post(f"/api/requests/{usdc['id']}/pay", {"pin": "1234", "asset": "NGN"})
    assert wrong_currency.json() == {"error": "This charge is in USDC. Swap to USDC first, then pay."}
    assert (await ada.post(f"/api/requests/{usdc['id']}/pay", {"pin": "1234"})).json()["asset"] == "USDC"

    assert (await shop.post("/api/requests", {"amount": 1, "asset": "BTC", "tag": "x"})).status_code == 400
    assert (await shop.post("/api/requests", {"amount": 0, "tag": "x"})).json() == {"error": "Enter an amount"}

    stale = await charge(shop)
    await sql(
        "UPDATE app.payment_requests SET expires_at = now() - interval '1 second' WHERE id = $1::uuid", stale["id"]
    )
    expired = await ada.post(f"/api/requests/{stale['id']}/pay", {"pin": "1234"})
    assert expired.json() == {"error": "This charge has expired."}
    assert (await ada.get("/api/requests/ZZZZZZ")).status_code == 404


async def test_cancel(make_person):
    shop, ada, stranger = await make_person(), await make_person(), await make_person()
    created = await charge(shop)
    await stranger.post(f"/api/requests/{created['id']}/cancel")
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["state"] == "pending"
    await shop.post(f"/api/requests/{created['id']}/cancel")
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["state"] == "cancelled"
    assert (await ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"})).status_code == 409


async def test_refund_once_in_the_charged_currency(make_person):
    shop, ada = await make_person(), await make_person()
    created = await charge(shop, 4, asset="USDC")
    await ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"})

    not_mine = await ada.post(f"/api/requests/{created['id']}/refund", {"pin": "1234"})
    assert not_mine.status_code == 404
    refunded = await shop.post(f"/api/requests/{created['id']}/refund", {"pin": "1234"})
    assert refunded.status_code == 200, refunded.text
    assert (await shop.post(f"/api/requests/{created['id']}/refund", {"pin": "1234"})).status_code == 409
    assert (await ada.balances())["USDC"] == 25
    assert (await shop.balances())["USDC"] == 25
    assert (await ada.get("/api/activity")).json()["entries"][0]["kind"] == "refund_in"


async def test_refund_needs_the_money_to_still_be_there(make_person):
    shop, ada, friend = await make_person(), await make_person(), await make_person()
    created = await charge(shop, 3, asset="USDC")
    await ada.post(f"/api/requests/{created['id']}/pay", {"pin": "1234"})
    await shop.post("/api/send", {"to": friend.handle, "asset": "USDC", "amount": 28, "pin": "1234"})
    broke = await shop.post(f"/api/requests/{created['id']}/refund", {"pin": "1234"})
    assert broke.json() == {"error": "Not enough balance to refund this payment."}
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["state"] == "paid"


async def test_bank_cards_are_simulated_in_test_mode(make_person):
    shop = await make_person()
    created = await charge(shop, 1500)
    card = await shop.post(f"/api/requests/{created['id']}/card", {"brand": "Verve"})
    assert card.status_code == 200, card.text
    assert card.json()["amount"] == 1500 and card.json()["brand"] == "Verve"
    after = (await shop.get(f"/api/requests/{created['id']}")).json()
    assert (after["state"], after["channel"], after["cardBrand"]) == ("paid", "card", "Verve")
    assert (await shop.balances())["NGN"] == 51500
    feed = (await shop.get("/api/activity")).json()["entries"][0]
    assert (feed["kind"], feed["title"], feed["amount"]) == ("payment_in", "Verve card", 1500)

    again = await shop.post(f"/api/requests/{created['id']}/card", {"brand": "Verve"})
    assert again.status_code == 409 and (await shop.balances())["NGN"] == 51500, "charged once"
    refund = await shop.post(f"/api/requests/{created['id']}/refund", {"pin": "1234"})
    assert refund.status_code == 409 and "card acquirer" in refund.json()["error"]


async def test_bank_cards_are_refused_outside_test_mode(make_person, monkeypatch):
    from tappi_api import engine

    async def mint_off(**_):
        raise engine.EngineError(403, "forbidden", "sandbox only")

    monkeypatch.setattr(engine, "sandbox_credit", mint_off)
    shop = await make_person()
    created = await charge(shop, 1500)
    card = await shop.post(f"/api/requests/{created['id']}/card", {"brand": "Verve"})
    assert card.status_code == 409 and "card acquirer" in card.json()["error"]
    assert (await shop.get(f"/api/requests/{created['id']}")).json()["state"] == "pending"
    assert (await shop.balances())["NGN"] == 50000, "nothing minted"


async def test_dashboard(make_person):
    shop, ada = await make_person(), await make_person()
    by_phone = await charge(shop, 500)
    await ada.post(f"/api/requests/{by_phone['id']}/pay", {"pin": "1234", "channel": "nfc"})
    dollars = await charge(shop, 2, asset="USDC")
    await ada.post(f"/api/requests/{dollars['id']}/pay", {"pin": "1234"})
    await charge(shop, 99)  # still open: not listed

    board = (await shop.get("/api/merchant")).json()
    assert board["todayTaps"] == 2
    assert board["todayUsdc"] == 2
    assert board["todayVolume"] == 500 + 2 * 1569
    # What the merchant can withdraw to a bank: their naira balance (₦50,000 test money + ₦500 sale).
    assert board["payoutBalance"] == 50500
    assert len(board["payments"]) == 2
    assert len(board["weekly"]) == 7 and board["weekly"][-1]["day"] == "Today"
    assert (await shop.post("/api/merchant/settle", {"pin": "1234"})).status_code in (404, 405), (
        "fake settlement is gone"
    )
