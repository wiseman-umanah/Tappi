"""Tappi AI against a scripted Groq (no network): the tool loop, buttons, chats, voice and speech."""

import base64
import json

import httpx
import pytest

from tappi_api.ai import groq
from tappi_api.settings import settings

WAV = b"RIFF" + b"\0" * 200


class FakeGroq:
    def __init__(self) -> None:
        self.replies: list[dict] = []
        self.chat_requests: list[dict] = []
        self.transcript = ""

    def answer(self, content: str) -> None:
        self.replies.append({"content": content})

    def call_tool(self, name: str, **arguments) -> None:
        call = {
            "id": f"call_{len(self.replies)}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }
        self.replies.append({"content": "", "tool_calls": [call]})

    def tool_outputs(self) -> list[dict]:
        last = self.chat_requests[-1]["messages"]
        return [json.loads(m["content"]) for m in last if m["role"] == "tool"]

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-groq-key"
        if request.url.path.endswith("/chat/completions"):
            self.chat_requests.append(json.loads(request.content))
            return httpx.Response(200, json={"choices": [{"message": self.replies.pop(0)}]})
        if request.url.path.endswith("/audio/transcriptions"):
            return httpx.Response(200, json={"text": self.transcript})
        if request.url.path.endswith("/audio/speech"):
            return httpx.Response(200, content=WAV)
        return httpx.Response(404)


@pytest.fixture
def fake_groq():
    fake = FakeGroq()
    groq.transport = httpx.MockTransport(fake.handle)
    yield fake
    groq.transport = None


async def test_languages(client):
    languages = (await client.get("/api/ai/languages")).json()["languages"]
    assert len(languages) == 14
    assert languages[1] == {"code": "en-pidgin", "label": "Nigerian Pidgin", "native": "Naija"}


async def test_a_reply_is_saved_and_voiced(make_person, fake_groq):
    ada = await make_person()
    fake_groq.answer("Hi! I can check your balance or help you send money.")
    turn = (await ada.post("/api/ai/chat", {"text": "hello"})).json()
    assert turn["reply"]["content"].startswith("Hi!")
    assert turn["title"] == "hello"

    system = fake_groq.chat_requests[0]["messages"][0]["content"]
    assert "Stellar" not in system and "XLM" not in system
    assert "USDT" in system and "test money" not in system, "no free money promised"

    assert (await ada.get(f"/api/ai/speech/{turn['speechId']}/ready")).json() == {"ready": True}
    audio = await ada.get(f"/api/ai/speech/{turn['speechId']}")
    assert audio.headers["content-type"] == "audio/wav" and audio.content == WAV

    chats = (await ada.get("/api/ai/conversations")).json()["conversations"]
    assert [c["id"] for c in chats] == [turn["conversationId"]]
    chat = (await ada.get(f"/api/ai/conversations/{turn['conversationId']}")).json()
    assert [m["role"] for m in chat["messages"]] == ["user", "assistant"]


async def test_follow_ups_carry_the_history(make_person, fake_groq):
    ada = await make_person()
    fake_groq.answer("Sure.")
    first = (await ada.post("/api/ai/chat", {"text": "remember the word mango", "speak": False})).json()
    assert first["speechId"] is None
    fake_groq.answer("Mango.")
    await ada.post("/api/ai/chat", {"text": "what word?", "conversationId": first["conversationId"], "speak": False})
    sent = [m["content"] for m in fake_groq.chat_requests[-1]["messages"][1:]]
    assert sent == ["remember the word mango", "Sure.", "what word?"]


async def test_tools_read_the_real_balance(make_person, fake_groq):
    ada = await make_person()
    fake_groq.call_tool("get_balances")
    fake_groq.answer("You have ₦50,000 and $25 USDC.")
    await ada.post("/api/ai/chat", {"text": "how much I get?", "speak": False})
    assert fake_groq.tool_outputs() == [{"NGN": 50000.0, "USDT": 0.0, "USDC": 25.0, "BTC": 0.0}]
    assert "tools" in fake_groq.chat_requests[0] and "tools" in fake_groq.chat_requests[1]


async def test_prepare_send_makes_a_button_and_moves_nothing(make_person, fake_groq):
    ada, bola = await make_person(), await make_person()
    fake_groq.call_tool("prepare_send", to=f"@{bola.handle}", asset="NGN", amount=5000)
    fake_groq.answer("Tap the button and confirm with your PIN.")
    turn = (await ada.post("/api/ai/chat", {"text": f"send 5k to {bola.handle}", "speak": False})).json()
    [action] = turn["reply"]["actions"]
    assert action["kind"] == "approve"
    assert action["label"] == f"Send ₦5,000 to @{bola.handle}"
    assert action["params"] | {"name": None} == {
        "action": "send",
        "to": bola.handle,
        "name": None,
        "asset": "NGN",
        "amount": "5000",
    }
    assert (await ada.balances())["NGN"] == 50000 and (await bola.balances())["NGN"] == 50000

    # The button survives reopening the chat.
    chat = (await ada.get(f"/api/ai/conversations/{turn['conversationId']}")).json()
    assert chat["messages"][1]["actions"] == [action]


async def test_tool_errors_go_back_to_the_model(make_person, fake_groq):
    ada = await make_person()
    fake_groq.call_tool("prepare_send", to="ghost_user", asset="NGN", amount=10)
    fake_groq.call_tool("prepare_send", to=ada.handle, asset="BTC", amount=1)
    fake_groq.call_tool("open_screen", screen="casino", label="Casino")
    fake_groq.answer("I couldn't find that user.")
    turn = (await ada.post("/api/ai/chat", {"text": "send", "speak": False})).json()
    assert turn["reply"]["actions"] == []
    outputs = [json.loads(m["content"]) for m in fake_groq.chat_requests[-1]["messages"] if m["role"] == "tool"]
    assert outputs == [
        {"error": "No Tappi user called @ghost_user."},
        {"error": "That's the user's own username."},
        {"error": "Unknown screen casino"},
    ]


async def test_tool_rounds_are_capped(make_person, fake_groq):
    ada = await make_person()
    for _ in range(4):
        fake_groq.call_tool("get_balances")
    fake_groq.answer("Done.")
    turn = (await ada.post("/api/ai/chat", {"text": "loop", "speak": False})).json()
    assert turn["reply"]["content"] == "Done."
    assert "tools" not in fake_groq.chat_requests[-1], "the last round must answer"


async def test_voice_message(make_person, fake_groq):
    ada = await make_person()
    fake_groq.transcript = "abeg wetin be my balance"
    fake_groq.answer("Your balance na ₦50,000.")
    audio = base64.b64encode(b"\0" * 500).decode()
    turn = (await ada.post("/api/ai/voice", {"audio": audio, "format": "m4a", "speak": False})).json()
    assert turn["question"] == turn["question"] | {"content": "abeg wetin be my balance", "spoken": True}
    assert fake_groq.chat_requests[0]["messages"][-1]["content"] == "(spoken, transcribed) abeg wetin be my balance"

    fake_groq.transcript = ""
    silent = await ada.post("/api/ai/voice", {"audio": audio, "speak": False})
    assert silent.json() == {"error": "I didn't catch that. Hold the mic and try again."}


async def test_languages_without_a_voice_go_without_audio(make_person, fake_groq):
    ada = await make_person()
    await ada.patch("/api/me", {"language": "yo"})
    fake_groq.answer("Ẹ káàbọ̀.")
    turn = (await ada.post("/api/ai/chat", {"text": "bawo"})).json()
    assert (await ada.get(f"/api/ai/speech/{turn['speechId']}/ready")).json() == {"ready": False}
    assert (await ada.get(f"/api/ai/speech/{turn['speechId']}")).status_code == 404


async def test_chats_are_private_and_deletable(make_person, fake_groq):
    ada, bola = await make_person(), await make_person()
    fake_groq.answer("Hi.")
    turn = (await ada.post("/api/ai/chat", {"text": "hi", "speak": True})).json()
    assert (await bola.get(f"/api/ai/conversations/{turn['conversationId']}")).status_code == 404
    assert (await bola.get(f"/api/ai/speech/{turn['speechId']}/ready")).status_code == 404
    assert (await ada.client.delete(f"/api/ai/conversations/{turn['conversationId']}", headers=ada.headers)).json() == {
        "ok": True
    }
    assert (await ada.get("/api/ai/conversations")).json() == {"conversations": []}


async def test_not_set_up_and_groq_errors(make_person, fake_groq):
    ada = await make_person()
    key = settings().groq_api_key
    settings().groq_api_key = None
    try:
        missing = await ada.post("/api/ai/chat", {"text": "hi"})
        assert missing.status_code == 503 and "GROQ_API_KEY" in missing.json()["error"]
    finally:
        settings().groq_api_key = key

    groq.transport = httpx.MockTransport(lambda _: httpx.Response(429))
    busy = await ada.post("/api/ai/chat", {"text": "hi"})
    assert busy.json() == {"error": "Tappi AI is busy. Try again in a few seconds."}
    assert (await ada.get("/api/ai/conversations")).json() == {"conversations": []}, "no empty chat left behind"
