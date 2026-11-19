from conftest import sign_in


async def test_disabled_accounts_take_nothing_in(make_person):
    ada, bola = await make_person(), await make_person()
    off = await bola.post("/api/me/receiving", {"enabled": False, "pin": "1234"})
    assert off.json()["account"]["status"] == "disabled"

    send = await ada.post("/api/send", {"to": bola.handle, "asset": "NGN", "amount": 1, "pin": "1234"})
    assert send.json() == {"error": f"@{bola.handle} isn't accepting payments right now."}
    assert (await bola.post("/api/requests", {"amount": 5, "tag": "x"})).status_code == 403
    # Still able to spend.
    assert (
        await bola.post("/api/send", {"to": ada.handle, "asset": "NGN", "amount": 1, "pin": "1234"})
    ).status_code == 200

    await bola.post("/api/me/receiving", {"enabled": True, "pin": "1234"})
    assert (
        await ada.post("/api/send", {"to": bola.handle, "asset": "NGN", "amount": 1, "pin": "1234"})
    ).status_code == 200


async def test_deleted_account_restores_within_the_window(client, make_person, sql):
    person = await make_person()
    email = (await person.get("/api/me")).json()["user"]["email"]
    charge = (await person.post("/api/requests", {"amount": 10, "tag": "x"})).json()
    await person.post("/api/me/delete", {"pin": "1234"})
    assert (await person.get(f"/api/requests/{charge['id']}")).status_code == 401

    headers = {"authorization": f"Bearer {await sign_in(client, email)}"}
    me = (await client.get("/api/me", headers=headers)).json()
    assert me["account"]["status"] == "deleting" and me["account"]["daysLeft"] == 30
    assert (await client.post("/api/send", json={}, headers=headers)).status_code == 403

    restored = (await client.post("/api/me/restore", headers=headers)).json()
    assert restored["account"]["status"] == "active"
    assert restored["wallet"]["balances"]["NGN"] == 50000
    cancelled = await client.get(f"/api/requests/{charge['id']}", headers=headers)
    assert cancelled.json()["state"] == "cancelled"


async def test_after_the_window_the_account_closes_and_the_email_starts_fresh(client, make_person, sql):
    person = await make_person()
    old = (await person.get("/api/me")).json()["user"]
    await person.fund("BTC", "0.001")
    await person.post("/api/me/delete", {"pin": "1234"})
    await sql("UPDATE app.users SET delete_after = now() - interval '1 second' WHERE id = $1::uuid", old["id"])

    headers = {"authorization": f"Bearer {await sign_in(client, old['email'])}"}
    fresh = (await client.get("/api/me", headers=headers)).json()
    assert fresh["user"]["id"] != old["id"]
    assert fresh["needsProfile"] is True

    [closed] = await sql(
        "SELECT status, email, handle, name, pin_hash, email_hash FROM app.users WHERE id = $1::uuid", old["id"]
    )
    assert closed["status"] == "closed"
    assert (
        closed["email"] is None and closed["handle"] is None and closed["name"] is None and closed["pin_hash"] is None
    )
    assert closed["email_hash"]
    swept = await sql(
        "SELECT asset, amount FROM app.entries WHERE user_id = $1::uuid AND kind = 'closure' ORDER BY asset", old["id"]
    )
    assert [(r["asset"], r["amount"]) for r in swept] == [("BTC", -100_000), ("NGN", -5_000_000), ("USDC", -25_000_000)]
    # The old handle is free again.
    assert (await client.get(f"/api/handles/{old['handle']}", headers=headers)).json()["available"] is True


async def test_purge_closes_due_accounts(make_person, sql):
    from tappi_api.account import purge_accounts

    person = await make_person()
    user_id = (await person.get("/api/me")).json()["user"]["id"]
    await person.post("/api/me/delete", {"pin": "1234"})
    await sql("UPDATE app.users SET delete_after = now() - interval '1 second' WHERE id = $1::uuid", user_id)
    result = await purge_accounts()
    assert result["closed"] >= 1
    [row] = await sql("SELECT status FROM app.users WHERE id = $1::uuid", user_id)
    assert row["status"] == "closed"
