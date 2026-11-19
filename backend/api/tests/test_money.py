import asyncio


async def test_send_moves_money_and_lists_it_for_both(make_person):
    ada, bola = await make_person(), await make_person()
    response = await ada.post("/api/send", {"to": f"@{bola.handle}", "asset": "NGN", "amount": 1250.5, "pin": "1234"})
    assert response.status_code == 200, response.text
    assert response.json()["to"].startswith("Test ")

    assert (await ada.balances())["NGN"] == 48749.5
    assert (await bola.balances())["NGN"] == 51250.5

    ada_latest = (await ada.get("/api/activity")).json()["entries"][0]
    bola_latest = (await bola.get("/api/activity")).json()["entries"][0]
    assert (ada_latest["kind"], ada_latest["amount"]) == ("payment_out", -1250.5)
    assert (bola_latest["kind"], bola_latest["amount"]) == ("payment_in", 1250.5)
    assert ada_latest["reference"] == bola_latest["reference"]


async def test_retrying_with_the_same_key_sends_once(make_person):
    ada, bola = await make_person(), await make_person()
    body = {"to": bola.handle, "asset": "USDC", "amount": 10, "pin": "1234"}
    key = {"Idempotency-Key": "phone-retry-1"}
    first = await ada.post("/api/send", body, headers=key)
    second = await ada.post("/api/send", body, headers=key)
    assert first.json()["reference"] == second.json()["reference"]
    assert (await ada.balances())["USDC"] == 15
    assert (await bola.balances())["USDC"] == 35
    outgoing = [e for e in (await ada.get("/api/activity")).json()["entries"] if e["kind"] == "payment_out"]
    assert len(outgoing) == 1

    changed = await ada.post("/api/send", {**body, "amount": 11}, headers=key)
    assert changed.status_code == 409


async def test_concurrent_sends_never_overdraw(make_person):
    ada, bola = await make_person(), await make_person()
    body = {"to": bola.handle, "asset": "USDC", "amount": 5, "pin": "1234"}
    results = await asyncio.gather(*(ada.post("/api/send", body) for _ in range(8)))
    ok = [r for r in results if r.status_code == 200]
    assert len(ok) == 5  # 25 USDC of test money, 5 each
    assert all(r.json() == {"error": "Not enough balance for this payment."} for r in results if r.status_code != 200)
    assert (await ada.balances())["USDC"] == 0
    assert (await bola.balances())["USDC"] == 50


async def test_send_refusals_move_nothing(make_person):
    ada, bola = await make_person(), await make_person()

    async def send(**changes):
        body = {"to": bola.handle, "asset": "NGN", "amount": 100, "pin": "1234", **changes}
        return (await ada.post("/api/send", body)).json()

    assert await send(amount=50_000.01) == {"error": "Not enough balance for this payment."}
    assert await send(pin="9999") == {"error": "Wrong PIN. 4 tries left."}
    assert await send(amount=0) == {"error": "Enter an amount"}
    assert await send(amount=1.005) == {"error": "NGN amounts have at most 2 decimal places"}
    assert await send(to="nobody_here") == {"error": "No Tappi user called @nobody_here."}
    assert await send(to=ada.handle) == {"error": "You can't send money to yourself."}
    assert "error" in await send(asset="ETH")
    assert (await ada.balances())["NGN"] == 50000
    assert (await bola.balances())["NGN"] == 50000


async def test_send_needs_a_pin_first(make_person):
    ada, bola = await make_person(pin=None), await make_person()
    response = await ada.post("/api/send", {"to": bola.handle, "asset": "NGN", "amount": 1, "pin": "1234"})
    assert response.json() == {"error": "Set a transaction PIN first."}


async def test_btc_keeps_satoshi_precision(make_person):
    ada, bola = await make_person(), await make_person()
    await ada.fund("BTC", "0.001")
    sent = await ada.post("/api/send", {"to": bola.handle, "asset": "BTC", "amount": "0.00012345", "pin": "1234"})
    assert sent.status_code == 200, sent.text
    assert (await ada.balances())["BTC"] == 0.00087655
    too_precise = await ada.post(
        "/api/send", {"to": bola.handle, "asset": "BTC", "amount": "0.000000001", "pin": "1234"}
    )
    assert too_precise.json() == {"error": "BTC amounts have at most 8 decimal places"}


async def test_users_lookup(make_person):
    ada, bola = await make_person(), await make_person()
    found = (await ada.get(f"/api/users/{bola.handle}")).json()
    assert found["handle"] == bola.handle
    assert (await ada.get("/api/users/ghost_user")).status_code == 404


async def test_signed_out_requests_are_refused(client):
    assert (await client.post("/api/send", json={})).status_code == 401
    assert (await client.get("/api/activity")).status_code == 401
