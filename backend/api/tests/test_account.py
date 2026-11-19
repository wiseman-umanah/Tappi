from conftest import sign_in


async def test_health(client):
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


async def test_sign_in_with_email_code(client):
    code = (await client.post("/api/auth/code", json={"email": "  Ada@Example.com "})).json()["devCode"]
    assert len(code) == 6

    wrong = await client.post(
        "/api/auth/verify", json={"email": "ada@example.com", "code": "000000" if code != "000000" else "111111"}
    )
    assert wrong.status_code == 400
    assert wrong.json() == {"error": "That code isn't right."}

    response = await client.post("/api/auth/verify", json={"email": "ada@example.com", "code": code})
    body = response.json()
    assert response.status_code == 200
    assert body["user"]["email"] == "ada@example.com"
    assert body["needsProfile"] is True
    assert body["hasPin"] is False
    assert body["wallet"] is None

    # A code works once.
    again = await client.post("/api/auth/verify", json={"email": "ada@example.com", "code": code})
    assert again.status_code == 400


async def test_too_many_wrong_codes(client):
    await client.post("/api/auth/code", json={"email": "bruteforce@example.com"})
    for _ in range(5):
        await client.post("/api/auth/verify", json={"email": "bruteforce@example.com", "code": "999999"})
    response = await client.post("/api/auth/verify", json={"email": "bruteforce@example.com", "code": "999999"})
    assert response.status_code == 429


async def test_bad_input_is_a_readable_error(client):
    response = await client.post("/api/auth/code", json={"email": "not-an-email"})
    assert response.status_code == 400
    assert isinstance(response.json()["error"], str)


async def test_logout_ends_the_session(client):
    token = await sign_in(client, "leaver@example.com")
    headers = {"authorization": f"Bearer {token}"}
    assert (await client.get("/api/me", headers=headers)).status_code == 200
    await client.post("/api/auth/logout", headers=headers)
    response = await client.get("/api/me", headers=headers)
    assert response.status_code == 401
    assert response.json() == {"error": "Please sign in again."}


async def test_a_new_account_starts_empty(make_person):
    """No free money: real money only arrives through Paga (bank transfer) or Bitnob (crypto)."""
    person = await make_person(funded=False)
    me = (await person.get("/api/me")).json()
    assert me["needsProfile"] is False
    assert me["user"]["handle"] == person.handle
    assert me["wallet"]["balances"] == {"NGN": 0.0, "USDT": 0.0, "USDC": 0.0, "BTC": 0.0}
    assert (await person.get("/api/activity")).json()["entries"] == []
    assert (await person.post("/api/wallet/fund", {"asset": "NGN"})).status_code in (404, 405), "test money is gone"


async def test_usernames(make_person):
    taken = await make_person()
    other = await make_person(profile=False)

    clash = await other.patch("/api/me", {"handle": taken.handle})
    assert clash.status_code == 409

    check = (await other.get(f"/api/handles/{taken.handle}", params={"name": "Ada Obi"})).json()
    assert check["available"] is False
    assert check["suggestions"] and taken.handle not in check["suggestions"]
    assert (await other.get("/api/handles/admin")).json()["available"] is False
    assert (await other.get("/api/handles/x")).json()["message"] == "Use 3–20 letters, numbers or _"

    bad = await other.patch("/api/me", {"handle": "no spaces"})
    assert bad.status_code == 400
    assert bad.json()["error"] == "Username: 3–20 letters, numbers or _"


async def test_pin_set_change_and_lockout(make_person):
    person = await make_person(pin=None)
    assert (await person.post("/api/me/pin", {"pin": "1234"})).status_code == 200
    assert (await person.get("/api/me")).json()["hasPin"] is True

    no_current = await person.post("/api/me/pin", {"pin": "5678"})
    assert no_current.json() == {"error": "Enter your current PIN."}
    same = await person.post("/api/me/pin", {"pin": "1234", "currentPin": "1234"})
    assert same.json() == {"error": "Choose a different PIN from your current one."}
    assert (await person.post("/api/me/pin", {"pin": "5678", "currentPin": "1234"})).status_code == 200

    for left in (4, 3, 2, 1):
        wrong = await person.post("/api/me/pin/check", {"pin": "0000"})
        assert wrong.json() == {"error": f"Wrong PIN. {left} tries left."}
    assert (await person.post("/api/me/pin/check", {"pin": "0000"})).json() == {
        "error": "Too many wrong PINs. Try again in 5 min."
    }
    # Locked: even the right PIN is refused for now.
    locked = await person.post("/api/me/pin/check", {"pin": "5678"})
    assert locked.status_code == 429


async def test_indicative_rate(client):
    assert (await client.get("/api/rate")).json() == {"ngnPerUsd": 1569, "indicative": True}
