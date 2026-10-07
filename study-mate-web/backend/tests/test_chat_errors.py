from __future__ import annotations

import asyncio
import json

import pytest

from app import errors, storage


@pytest.mark.parametrize("scenario,code", [
    ("partial503", "upstream_http"), ("empty503", "upstream_http"),
    ("unexpected_eof", "upstream_eof"), ("transport_error", "upstream_transport"),
])
def test_error_fixture_persists_structured_terminal(client, scenario, code):
    response = client.post("/api/chat/stream", json={"message": "请讲解", "fixture_scenario": scenario})
    assert response.status_code == 200
    events = []
    for block in response.text.split("\n\n"):
        lines = block.splitlines()
        name = next((s[7:] for s in lines if s.startswith("event: ")), "")
        raw = next((s[6:] for s in lines if s.startswith("data: ")), None)
        if raw:
            events.append((name, json.loads(raw)))
    session_id = next(value["session_id"] for name, value in events if name == "session")
    error = next(value for name, value in events if name == "error")
    assert error["code"] == code
    saved = storage.require_session(session_id)["messages"][-1]
    assert saved["stream_state"] == "error"
    assert saved["error"]["code"] == code
    assert saved["error"]["request_id"] == saved["turn_id"]
    assert not any("预算" in value.get("message", "") for name, value in events if name == "notice")
    if "503" in scenario:
        assert saved["error"]["status"] == 503
        assert saved["error"]["upstream_code"] == "system_memory_overloaded"
    if scenario == "partial503":
        assert saved["content"]
    if scenario == "empty503":
        assert saved["content"] == ""


def test_stop_intent_is_scoped_to_active_turn(client):
    sid = storage.create_session()["id"]
    assert client.post(f"/api/sessions/{sid}/stop").json()["stop"] is False
    errors.register_turn(sid, "first")
    assert client.post(f"/api/sessions/{sid}/stop").json()["stop"] is True
    errors.clear_turn(sid, "first")
    errors.register_turn(sid, "second")
    assert not errors.consume_stop(sid, "second")
    errors.clear_turn(sid, "second")


def test_cancellation_without_intent_is_not_user_stop():
    info = errors.from_exception(asyncio.CancelledError())
    assert info.code != "user_stopped"


@pytest.mark.parametrize("text", [
    '{"api_key": "secret-value-123"}',
    "{'authorization': 'Bearer secret-value-123'}",
    "Authorization: Bearer secret-value-123",
])
def test_error_details_redact_quoted_and_header_secrets(text):
    assert "secret-value-123" not in errors.redact_text(text)


def test_sdk_error_metadata_survives_normalization():
    class SDKError(Exception):
        status_code = 503
        body = {"error": {"code": "system_memory_overloaded", "message": "overloaded"}}
    info = errors.from_exception(SDKError("Error code: 503 - {'error': {'code': 'system_memory_overloaded'}}"))
    assert info.status == 503
    assert info.upstream_code == "system_memory_overloaded"
